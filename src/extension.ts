import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8000;
const LOG_PREFIX = "[SemanticSearch]";
const DEBOUNCE_MS = 300;
const BACKEND_READY_TIMEOUT_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;
const WORKSPACE_INDEX_TIMEOUT_MS = 120000;
const FILE_INDEX_TIMEOUT_MS = 30000;

let isIndexed = false;
let isIndexing = false;
let backendProcess: ChildProcess | undefined;
let backendStarting: Thenable<boolean> | undefined;
let backendOutput: vscode.OutputChannel | undefined;
const debounceTimers = new Map<string, NodeJS.Timeout>();

interface SearchResult {
  score: number;
  function_name: string;
  file_path: string;
  code: string;
  start_line: number;
  end_line: number;
}

interface SearchResponse {
  results: SearchResult[];
  message?: string;
  error?: string;
}

interface IndexResponse {
  status: string;
  detail:
    | string
    | {
        status: string;
        functions_indexed?: number;
        functions_updated?: number;
        total_functions?: number;
      };
}

interface HealthResponse {
  status: string;
}

interface ResultQuickPickItem extends vscode.QuickPickItem {
  _result: SearchResult;
}

function log(message: string, ...args: unknown[]): void {
  console.log(`${LOG_PREFIX} ${message}`, ...args);
}

function logError(message: string, ...args: unknown[]): void {
  console.error(`${LOG_PREFIX} ${message}`, ...args);
}

function getBackendOutput(): vscode.OutputChannel {
  if (!backendOutput) {
    backendOutput = vscode.window.createOutputChannel("Semantic Search Backend");
  }
  return backendOutput;
}

function getExtensionRoot(context: vscode.ExtensionContext): string {
  return context.extensionUri.fsPath;
}

function resolvePythonCommand(extensionRoot: string): string {
  const bundledPython =
    process.platform === "win32"
      ? path.join(extensionRoot, "backend", ".venv", "Scripts", "python.exe")
      : path.join(extensionRoot, "backend", ".venv", "bin", "python");

  if (fs.existsSync(bundledPython)) {
    return bundledPython;
  }

  return process.platform === "win32" ? "python" : "python3";
}

function buildPythonEnv(extensionRoot: string): NodeJS.ProcessEnv {
  const pythonPath = process.env.PYTHONPATH;
  return {
    ...process.env,
    PYTHONPATH: pythonPath
      ? `${extensionRoot}${path.delimiter}${pythonPath}`
      : extensionRoot,
  };
}

function requestJSON<T>(
  method: string,
  urlPath: string,
  body?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string | number> = {};

    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }

    const options: http.RequestOptions = {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: urlPath,
      method,
      headers,
      timeout: timeoutMs,
    };

    log(`HTTP ${method} ${urlPath} -> sending`, body ?? {});

    const req = http.request(options, (res) => {
      let chunks = "";
      res.on("data", (chunk: Buffer | string) => {
        chunks += chunk.toString();
      });
      res.on("end", () => {
        if (!chunks.trim()) {
          reject(new Error("Empty response from backend"));
          return;
        }

        try {
          const parsed = JSON.parse(chunks) as T;
          log(`HTTP ${method} ${urlPath} <- ${res.statusCode ?? "unknown"}`, parsed);
          resolve(parsed);
        } catch {
          logError(`HTTP ${method} ${urlPath} <- invalid JSON`, chunks);
          reject(new Error("Invalid JSON from backend"));
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    req.on("error", (err: Error) => {
      logError(`HTTP ${method} ${urlPath} failed`, err);
      reject(err);
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
}

function getJSON<T>(urlPath: string): Promise<T> {
  return requestJSON<T>("GET", urlPath);
}

function postJSON<T>(
  urlPath: string,
  body: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  return requestJSON<T>("POST", urlPath, body, timeoutMs);
}

function deleteJSON<T>(
  urlPath: string,
  body: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  return requestJSON<T>("DELETE", urlPath, body, timeoutMs);
}

async function isBackendHealthy(): Promise<boolean> {
  try {
    const health = await getJSON<HealthResponse>("/health");
    return health.status === "ok";
  } catch {
    return false;
  }
}

async function waitForBackendReady(maxWaitMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    // eslint-disable-next-line no-await-in-loop
    const healthy = await isBackendHealthy();
    if (healthy) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function ensureBackendRunning(context: vscode.ExtensionContext): Promise<boolean> {
  if (await isBackendHealthy()) {
    return true;
  }

  if (backendStarting) {
    return backendStarting;
  }

  backendStarting = vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Semantic Search: Starting backend...",
      cancellable: false,
    },
    async () => {
      const extensionRoot = getExtensionRoot(context);
      const pythonCommand = resolvePythonCommand(extensionRoot);
      const output = getBackendOutput();

      try {
        if (await isBackendHealthy()) {
          return true;
        }

        output.appendLine(
          `${LOG_PREFIX} Spawning backend from ${extensionRoot} with ${pythonCommand}`
        );

        backendProcess = spawn(
          pythonCommand,
          [
            "-m",
            "uvicorn",
            "backend.api.app:app",
            "--host",
            BACKEND_HOST,
            "--port",
            String(BACKEND_PORT),
            "--app-dir",
            extensionRoot,
          ],
          {
            cwd: extensionRoot,
            env: buildPythonEnv(extensionRoot),
            windowsHide: true,
          }
        );

        backendProcess.stdout?.on("data", (data: Buffer) => output.append(data.toString()));
        backendProcess.stderr?.on("data", (data: Buffer) => output.append(data.toString()));
        backendProcess.on("exit", (code, signal) => {
          output.appendLine(
            `${LOG_PREFIX} Backend exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
          );
          backendProcess = undefined;
        });

        const ready = await waitForBackendReady(BACKEND_READY_TIMEOUT_MS);
        if (!ready) {
          output.show(true);
          vscode.window.showErrorMessage(
            "Backend did not start in time. Check the 'Semantic Search Backend' output channel."
          );
          return false;
        }

        return true;
      } catch (err) {
        logError("Failed to start backend", err);
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Failed to start backend: ${message}`);
        return false;
      } finally {
        backendStarting = undefined;
      }
    }
  );

  return await Promise.resolve(backendStarting);
}

async function ensureIndexed(workspaceRoot: string): Promise<boolean> {
  log(
    `ensureIndexed called: workspaceRoot=${workspaceRoot}, isIndexed=${isIndexed}, isIndexing=${isIndexing}`
  );

  if (isIndexed) {
    return true;
  }

  if (isIndexing) {
    vscode.window.showInformationMessage("Indexing in progress, please wait...");
    return false;
  }

  isIndexing = true;

  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Semantic Search: Indexing workspace...",
        cancellable: false,
      },
      async () =>
        postJSON<IndexResponse>("/index/workspace", {
          root_path: workspaceRoot,
        }, WORKSPACE_INDEX_TIMEOUT_MS)
    );

    if (result.status === "error") {
      const detail =
        typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail);
      vscode.window.showErrorMessage(`Indexing failed: ${detail}`);
      return false;
    }

    isIndexed = true;
    const count =
      typeof result.detail === "object" ? (result.detail.functions_indexed ?? 0) : 0;

    vscode.window.showInformationMessage(`Indexing complete: ${count} functions indexed.`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Full workspace indexing threw for ${workspaceRoot}`, err);
    vscode.window.showErrorMessage(`Indexing error: ${message}`);
    return false;
  } finally {
    isIndexing = false;
  }
}

async function openFileAtRange(
  workspaceRoot: string,
  filePath: string,
  startLine: number,
  endLine: number
): Promise<void> {
  const fullPath = path.join(workspaceRoot, filePath);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
  const editor = await vscode.window.showTextDocument(document);

  const start = new vscode.Position(Math.max(startLine - 1, 0), 0);
  const end = new vscode.Position(Math.max(endLine - 1, 0), 0);
  const range = new vscode.Range(start, end);

  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function handleSearch(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open.");
    return;
  }

  const workspaceRoot = folders[0].uri.fsPath;
  const backendReady = await ensureBackendRunning(context);
  if (!backendReady) {
    return;
  }

  const indexed = await ensureIndexed(workspaceRoot);
  if (!indexed) {
    return;
  }

  const query = await vscode.window.showInputBox({
    prompt: "Semantic Code Search",
    placeHolder: "Describe the function you are looking for...",
  });

  if (!query || !query.trim()) {
    return;
  }

  let response: SearchResponse;
  try {
    response = await postJSON<SearchResponse>("/search", {
      query: query.trim(),
      top_k: 5,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Search failed: ${message}`);
    return;
  }

  if (response.error) {
    vscode.window.showErrorMessage(response.error);
    return;
  }

  const results = response.results ?? [];
  if (results.length === 0) {
    vscode.window.showInformationMessage(response.message ?? "No results found.");
    return;
  }

  if (results.length === 1) {
    const result = results[0];
    await openFileAtRange(workspaceRoot, result.file_path, result.start_line, result.end_line);
    return;
  }

  const items: ResultQuickPickItem[] = results.map((result) => ({
    label: result.function_name,
    description: result.file_path,
    detail: `Score: ${result.score.toFixed(3)} | Lines ${result.start_line}-${result.end_line}`,
    _result: result,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a function",
  });

  if (picked) {
    const result = picked._result;
    await openFileAtRange(workspaceRoot, result.file_path, result.start_line, result.end_line);
  }
}

function setupFileWatcher(context: vscode.ExtensionContext, workspaceRoot: string): void {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");

  const handleFileChange = (uri: vscode.Uri): void => {
    if (isIndexing || !isIndexed) {
      return;
    }

    const filePath = uri.fsPath;
    const existing = debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    debounceTimers.set(
      filePath,
      setTimeout(() => {
        debounceTimers.delete(filePath);
        postJSON("/index/file", {
          file_path: filePath,
          root_path: workspaceRoot,
        }, FILE_INDEX_TIMEOUT_MS).catch((err) => {
          logError(`Incremental index failed for ${filePath}`, err);
        });
      }, DEBOUNCE_MS)
    );
  };

  const handleFileDelete = (uri: vscode.Uri): void => {
    if (isIndexing || !isIndexed) {
      return;
    }

    const filePath = uri.fsPath;
    const existing = debounceTimers.get(filePath);
    if (existing) {
      clearTimeout(existing);
      debounceTimers.delete(filePath);
    }

    deleteJSON("/index/file", {
      file_path: filePath,
      root_path: workspaceRoot,
    }, FILE_INDEX_TIMEOUT_MS).catch((err) => {
      logError(`Delete index failed for ${filePath}`, err);
    });
  };

  watcher.onDidCreate(handleFileChange);
  watcher.onDidChange(handleFileChange);
  watcher.onDidDelete(handleFileDelete);
  context.subscriptions.push(watcher);
}

export function activate(context: vscode.ExtensionContext): void {
  log("Extension activated");

  context.subscriptions.push(getBackendOutput());
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticSearch.search", async () => {
      await handleSearch(context);
    })
  );

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return;
  }

  const workspaceRoot = folders[0].uri.fsPath;
  void (async () => {
    const backendReady = await ensureBackendRunning(context);
    if (!backendReady) {
      return;
    }

    const indexed = await ensureIndexed(workspaceRoot);
    if (indexed) {
      setupFileWatcher(context, workspaceRoot);
    }
  })();
}

export function deactivate(): void {
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  try {
    backendProcess?.kill();
  } catch {
    // ignore shutdown errors
  }
}
