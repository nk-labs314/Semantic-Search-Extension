# Semantic Search Ext

Semantic Search Ext helps you find Python functions in an open VS Code workspace by describing what they do. Instead of searching for an exact name or string, you can search for something like `validate an API token` or `load a user's saved settings`.

The extension builds a local index of the workspace, then shows the closest matching functions. Selecting a result opens the file at the matching lines.

## Requirements

- Windows x64 (64-bit Intel or AMD processor)
- Visual Studio Code 1.80 or later
- A folder opened as a VS Code workspace
- Python source files to search

The current release does not support macOS, Linux, Windows on ARM, or non-Python source files.

## How to use it

1. Install **Semantic Search Ext** from the VS Code Marketplace.
2. Open a folder containing your Python project in VS Code.
3. On first use, wait while the extension downloads its local runtime and indexes the workspace. This can take a little while for larger projects.
4. Press `Ctrl+Shift+K`, or open the Command Palette (`Ctrl+Shift+P`) and run **Semantic Code Search**.
5. Describe the function you want to find, then choose a result to open it.

For example, try searches such as:

- `parse a configuration file`
- `check whether a user can access a resource`
- `save results to the database`

## Commands

- **Semantic Code Search**: search the open workspace.
- **Semantic Search: Install Runtime**: download the local runtime if it was not installed automatically.
- **Semantic Search: Reinstall Runtime**: download a fresh copy of the runtime.
- **Semantic Search: Show Backend Logs**: open logs to help diagnose startup or indexing problems.

## Privacy and first run

Code indexing and search run locally on your machine. The extension needs an internet connection only to download its runtime on first use. After that, it starts the local backend and indexes the open workspace automatically.

## Troubleshooting

If search does not start, run **Semantic Search: Install Runtime** from the Command Palette. If it still fails, open **Semantic Search: Show Backend Logs** and check the error message.

## License

See [LICENSE.txt](LICENSE.txt).
