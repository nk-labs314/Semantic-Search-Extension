import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";

const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT = 8000;
const CONFIG_SECTION = "semanticSearch";
const LOG_PREFIX = "[SemanticSearch]";
const DEBOUNCE_MS = 300;
const BACKEND_READY_TIMEOUT_MS = 20000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2000;
const WORKSPACE_INDEX_TIMEOUT_MS = 120000;
const FILE_INDEX_TIMEOUT_MS = 30000;
const RUNTIME_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const RUNTIME_ARCHIVE_PREFIX = "semantic-search-runtime";

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
  workspace_indexed?: boolean;
  app_root?: string;
}

interface RuntimeManifest {
  version: string;
  platform: string;
  pythonRelativePath?: string;
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

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function getExtensionRoot(context: vscode.ExtensionContext): string {
  return context.extensionUri.fsPath;
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function safeRm(targetPath: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

function getPackageVersion(context: vscode.ExtensionContext): string {
  return String(context.extension.packageJSON.version ?? "0.0.1");
}

function getRuntimeVersion(context: vscode.ExtensionContext): string {
  const configured = getConfig().get<string>("runtimeVersion", "").trim();
  return configured || getPackageVersion(context);
}

function getPlatformKey(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;
  const supported = new Set([
    "win32-x64",
    "win32-arm64",
    "darwin-x64",
    "darwin-arm64",
    "linux-x64",
    "linux-arm64",
  ]);
  const key = `${platform}-${arch}`;
  return supported.has(key) ? key : undefined;
}

function getArchiveExtension(platformKey: string): "zip" | "tar.gz" {
  return platformKey.startsWith("win32-") ? "zip" : "tar.gz";
}

function getArtifactFileName(platformKey: string): string {
  return `${RUNTIME_ARCHIVE_PREFIX}-${platformKey}.${getArchiveExtension(platformKey)}`;
}

function normalizeGitHubUrl(url: string): string {
  return url.replace(/^git\+/, "").replace(/\.git$/, "");
}

function deriveRuntimeBaseUrl(context: vscode.ExtensionContext): string | undefined {
  const configured = getConfig().get<string>("runtimeBaseUrl", "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const repository = context.extension.packageJSON.repository;
  const rawUrl =
    typeof repository === "string"
      ? repository
      : typeof repository?.url === "string"
        ? repository.url
        : "";
  const normalized = normalizeGitHubUrl(rawUrl);
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  if (!match) {
    return undefined;
  }

  const owner = match[1];
  const repo = match[2];
  return `https://github.com/${owner}/${repo}/releases/download/v${getRuntimeVersion(context)}`;
}

function getManagedRuntimeRoot(context: vscode.ExtensionContext): string | undefined {
  const platformKey = getPlatformKey();
  if (!platformKey) {
    return undefined;
  }

  return path.join(
    context.globalStorageUri.fsPath,
    "runtime",
    getRuntimeVersion(context),
    platformKey
  );
}

function getRuntimeManifestPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, "runtime-manifest.json");
}

function readRuntimeManifest(runtimeRoot: string): RuntimeManifest | undefined {
  const manifestPath = getRuntimeManifestPath(runtimeRoot);
  if (!fileExists(manifestPath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as RuntimeManifest;
  } catch {
    return undefined;
  }
}

function isManagedRuntimeInstalled(context: vscode.ExtensionContext): boolean {
  const runtimeRoot = getManagedRuntimeRoot(context);
  const platformKey = getPlatformKey();
  if (!runtimeRoot || !platformKey) {
    return false;
  }

  const manifest = readRuntimeManifest(runtimeRoot);
  if (!manifest) {
    return false;
  }

  return (
    manifest.version === getRuntimeVersion(context) && manifest.platform === platformKey
  );
}

function getPythonPathForAppRoot(appRoot: string, manifest?: RuntimeManifest): string {
  if (manifest?.pythonRelativePath) {
    return path.join(appRoot, manifest.pythonRelativePath);
  }

  return process.platform === "win32"
    ? path.join(appRoot, "backend", ".venv", "Scripts", "python.exe")
    : path.join(appRoot, "backend", ".venv", "bin", "python");
}

function localDevBundleAvailable(extensionRoot: string): boolean {
  const modelPath = path.join(extensionRoot, "backend", "assets", "best_model.pt");
  const tokenizerDir = path.join(extensionRoot, "backend", "assets", "codebert-base");
  const pythonPath = getPythonPathForAppRoot(extensionRoot);
  return fileExists(modelPath) && fileExists(tokenizerDir) && fileExists(pythonPath);
}

function buildPythonEnv(appRoot: string): NodeJS.ProcessEnv {
  const pythonPath = process.env.PYTHONPATH;
  return {
    ...process.env,
    PYTHONPATH: pythonPath ? `${appRoot}${path.delimiter}${pythonPath}` : appRoot,
    PYTHONDONTWRITEBYTECODE: "1",
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

function spawnAndWait(
  command: string,
  args: string[],
  cwd: string,
  output: vscode.OutputChannel
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
    });

    child.stdout?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code ?? "null"}`));
      }
    });
  });
}

function extractArchive(
  archivePath: string,
  destination: string,
  output: vscode.OutputChannel
): Promise<void> {
  ensureDirectory(destination);

  if (archivePath.endsWith(".zip")) {
    if (process.platform !== "win32") {
      return Promise.reject(new Error("ZIP extraction is only configured for Windows"));
    }

    return spawnAndWait(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
      ],
      destination,
      output
    );
  }

  return spawnAndWait("tar", ["-xzf", archivePath, "-C", destination], destination, output);
}

function downloadFile(
  url: string,
  destination: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirectsRemaining = 5;

    const requestUrl = (currentUrl: string): void => {
      const client = currentUrl.startsWith("https:") ? https : http;
      const request = client.get(currentUrl, (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location && redirectsRemaining > 0) {
          redirectsRemaining -= 1;
          response.resume();
          requestUrl(new URL(location, currentUrl).toString());
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`Runtime download failed with HTTP ${status}`));
          return;
        }

        const totalBytes = Number(response.headers["content-length"] ?? 0);
        let downloaded = 0;
        const file = fs.createWriteStream(destination);

        response.on("data", (chunk: Buffer) => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const percent = Math.max(1, Math.min(95, Math.floor((downloaded / totalBytes) * 95)));
            progress.report({ increment: percent / 10, message: `Downloading runtime ${percent}%` });
          } else {
            progress.report({ message: `Downloading runtime (${Math.floor(downloaded / 1024 / 1024)} MB)` });
          }
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          file.close();
          reject(err);
        });
      });

      request.setTimeout(RUNTIME_DOWNLOAD_TIMEOUT_MS, () => {
        request.destroy(new Error("Runtime download timed out"));
      });
      request.on("error", reject);
    };

    requestUrl(url);
  });
}

async function installManagedRuntime(
  context: vscode.ExtensionContext,
  forceReinstall: boolean
): Promise<string | undefined> {
  const platformKey = getPlatformKey();
  if (!platformKey) {
    vscode.window.showErrorMessage(
      `Semantic Search does not yet support platform ${process.platform}-${process.arch}.`
    );
    return undefined;
  }

  const baseUrl = deriveRuntimeBaseUrl(context);
  if (!baseUrl) {
    vscode.window.showErrorMessage(
      "Runtime download URL is not configured. Set semanticSearch.runtimeBaseUrl before publishing."
    );
    return undefined;
  }

  const runtimeRoot = getManagedRuntimeRoot(context);
  if (!runtimeRoot) {
    return undefined;
  }

  if (!forceReinstall && isManagedRuntimeInstalled(context)) {
    return runtimeRoot;
  }

  const output = getBackendOutput();
  const archiveName = getArtifactFileName(platformKey);
  const downloadUrl = `${baseUrl}/${archiveName}`;
  const downloadsDir = path.join(context.globalStorageUri.fsPath, "downloads");
  const tempDir = path.join(context.globalStorageUri.fsPath, "tmp");
  ensureDirectory(context.globalStorageUri.fsPath);
  ensureDirectory(downloadsDir);
  ensureDirectory(tempDir);

  const archivePath = path.join(downloadsDir, archiveName);
  const extractDir = path.join(tempDir, `runtime-${Date.now()}`);

  output.appendLine(`${LOG_PREFIX} Installing runtime from ${downloadUrl}`);

  const installedRoot = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: forceReinstall ? "Semantic Search: Reinstalling runtime..." : "Semantic Search: Installing runtime...",
      cancellable: false,
    },
    async (progress) => {
      safeRm(archivePath);
      safeRm(extractDir);
      safeRm(runtimeRoot);

      await downloadFile(downloadUrl, archivePath, progress);
      progress.report({ message: "Extracting runtime..." });
      await extractArchive(archivePath, extractDir, output);

      const manifestPath = getRuntimeManifestPath(extractDir);
      if (!fileExists(manifestPath)) {
        throw new Error("Downloaded runtime archive is missing runtime-manifest.json");
      }

      ensureDirectory(path.dirname(runtimeRoot));
      fs.renameSync(extractDir, runtimeRoot);
      safeRm(archivePath);
      return runtimeRoot;
    }
  );

  return installedRoot;
}

async function resolveBackendAppRoot(
  context: vscode.ExtensionContext,
  forceRuntimeInstall: boolean
): Promise<string | undefined> {
  const extensionRoot = getExtensionRoot(context);

  if (!forceRuntimeInstall && isManagedRuntimeInstalled(context)) {
    return getManagedRuntimeRoot(context);
  }

  if (!forceRuntimeInstall && localDevBundleAvailable(extensionRoot)) {
    return extensionRoot;
  }

  const autoInstall = getConfig().get<boolean>("autoInstallRuntime", true);
  if (!autoInstall && !forceRuntimeInstall) {
    return undefined;
  }

  return installManagedRuntime(context, forceRuntimeInstall);
}

async function ensureBackendRunning(
  context: vscode.ExtensionContext,
  forceRuntimeInstall: boolean = false
): Promise<boolean> {
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
      const appRoot = await resolveBackendAppRoot(context, forceRuntimeInstall);
      const output = getBackendOutput();

      if (!appRoot) {
        vscode.window.showErrorMessage(
          "Semantic Search runtime is not installed. Run 'Semantic Search: Install Runtime'."
        );
        return false;
      }

      const manifest = readRuntimeManifest(appRoot);
      const pythonCommand = getPythonPathForAppRoot(appRoot, manifest);
      if (!fileExists(pythonCommand)) {
        vscode.window.showErrorMessage(`Missing Python runtime: ${pythonCommand}`);
        return false;
      }

      try {
        if (await isBackendHealthy()) {
          return true;
        }

        output.appendLine(`${LOG_PREFIX} Spawning backend from ${appRoot} with ${pythonCommand}`);

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
            appRoot,
          ],
          {
            cwd: appRoot,
            env: buildPythonEnv(appRoot),
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
        postJSON<IndexResponse>(
          "/index/workspace",
          {
            root_path: workspaceRoot,
          },
          WORKSPACE_INDEX_TIMEOUT_MS
        )
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
        postJSON(
          "/index/file",
          {
            file_path: filePath,
            root_path: workspaceRoot,
          },
          FILE_INDEX_TIMEOUT_MS
        ).catch((err) => {
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

    deleteJSON(
      "/index/file",
      {
        file_path: filePath,
        root_path: workspaceRoot,
      },
      FILE_INDEX_TIMEOUT_MS
    ).catch((err) => {
      logError(`Delete index failed for ${filePath}`, err);
    });
  };

  watcher.onDidCreate(handleFileChange);
  watcher.onDidChange(handleFileChange);
  watcher.onDidDelete(handleFileDelete);
  context.subscriptions.push(watcher);
}

async function installRuntimeCommand(
  context: vscode.ExtensionContext,
  forceReinstall: boolean
): Promise<void> {
  const root = await installManagedRuntime(context, forceReinstall);
  if (root) {
    vscode.window.showInformationMessage(
      forceReinstall
        ? "Semantic Search runtime reinstalled."
        : "Semantic Search runtime installed."
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  log("Extension activated");

  context.subscriptions.push(getBackendOutput());
  context.subscriptions.push(
    vscode.commands.registerCommand("semanticSearch.search", async () => {
      await handleSearch(context);
    }),
    vscode.commands.registerCommand("semanticSearch.installRuntime", async () => {
      await installRuntimeCommand(context, false);
    }),
    vscode.commands.registerCommand("semanticSearch.reinstallRuntime", async () => {
      await installRuntimeCommand(context, true);
    }),
    vscode.commands.registerCommand("semanticSearch.showBackendLogs", async () => {
      getBackendOutput().show(true);
    })
  );

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return;
  }

  if (!getConfig().get<boolean>("autoIndexOnStartup", true)) {
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
