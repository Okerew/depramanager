# Depramanager Documentation

Showcase:
<a href="https://youtu.be/gHTd4CFbHas"><img src="https://cdn.glitch.global/a876511c-32af-4497-ae48-bc7d305558bb/icon.png?v=1739468743961"></a>

## Overview

The Depramanger is a Visual Studio Code (VSCode) extension designed to help developers manage dependencies for various programming languages. It provides functionalities to analyze, sync, update, and install dependencies, ensuring that your project's dependencies are up-to-date and correctly declared.

## Features

- **Dependency Analysis**: Scans your workspace to identify declared, installed, missing, and extra dependencies, also depedency trees.
- **Sync Declarations**: Automatically adds missing dependencies to your project's dependency files.
- **Check for Updates**: Notifies you of outdated dependencies and allows you to update them.
- **Install Specific Dependency, uninstall also**: Allows you to install, uninstall dependencies for your project, making it easier to install and uninstall.
- **Extension Recommendations**: Suggests and installs recommended VSCode extensions for your project's programming language.
- **Highlights outdated dependencies** Highlights outdated dependencies in the editor in the configuration file of the given language.
- **Scans for vulnerabilities** Scans for vulnerabilities in the dependencies of your project.

- **Installs dependencies from a specified file** Installs dependencies defined in the file opened in VSCode.

## Supported Languages

- Python
- Node.js
- Go
- Rust
- PHP

## Installation

1. Open VSCode.
2. Go to the Extensions view by clicking on the Extensions icon in the Activity Bar on the side of the window or by pressing `Ctrl+Shift+X`.
3. Search for "Enhanced Dependency Checker".
4. Click "Install" to install the extension.

## Usage

### Commands

The extension provides several commands that can be accessed through the Command Palette (`Ctrl+Shift+P`) or (`Cmd+Shift+P`).

#### 1. Scan Dependencies
<img src="https://cdn.glitch.global/a876511c-32af-4497-ae48-bc7d305558bb/dep_trees.png?v=1739802587808">

- **Command**: `Depramanager: scanDependencies`
- **Description**: Scans the workspace for dependencies and generates a report.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Scan Dependencies` and select it.
  3. The extension will scan your workspace and display a report in a new webview panel.

#### 2. Sync Declarations

- **Command**: `Depramanger: syncDeclarations`
- **Description**: Syncs missing declarations by adding them to the primary dependency file.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Sync Declarations` and select it.
  3. The extension will sync the missing declarations and notify you upon completion.

#### 3. Check for Updates

- **Command**: `Depramanger: checkUpdates`
- **Description**: Checks for outdated dependencies and prompts you to update them.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Check for Updates and Update dependencies` and select it.
  3. The extension will check for updates and prompt you to select dependencies to update.

#### 4. Install Specific Dependency
<img src="https://cdn.glitch.global/a876511c-32af-4497-ae48-bc7d305558bb/install.png?v=1739802582647">
- **Command**: `Depramanger: installDependency`
- **Description**: Allows you to install a specific dependency for your project.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Install Specific Dependency` and select it.
  3. Follow the prompts to select the programming language and enter the dependency name.
  4. The extension will install the dependency and add it to the primary dependency file.

#### 5. Scan Vulnerabilities

- **Command**: `Depramanager: scanVulnerabilities`
- **Description**: Scans the dependencies of your project for vulnerabilities.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Scan Vulnerabilities` and select it.
  3. The extension will scan the dependencies for vulnerabilities and display a report in a new webview panel.

#### 6. Scan depedencies without the depedency trees
<img src="https://cdn.glitch.global/a876511c-32af-4497-ae48-bc7d305558bb/deps_installed.png?v=1739802586578">

- **Command**: `Depramanager: dependencyChecker.scanDependenciesWithoutDepedencyTrees`
- **Description**: Scans the workspace for dependencies and generates a report without the dependency trees.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Depramanger: Scan Dependencies Without Dependency Tree` and select it.
  3. The extension will scan your workspace and display a report in a new webview panel.

#### 7. Uninstall depedencies
<img src="https://cdn.glitch.global/a876511c-32af-4497-ae48-bc7d305558bb/uninstall.png?v=1739802588836">

- **Command**: `Depramanager: dependencyChecker.uninstallDependency`
- **Description**: Uninstalls a specific dependency for your project.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Depramanger: Uninstall Dependencies` and select it.
  3. Follow the prompts to select the programming language and enter the dependency name.

#### 8. Check Current File Imports
- **Command**: `Depramanager: checkCurrentFileImports`
- **Description**: Checks the current file for imports and installs missing dependencies.
- **Usage**:
  1. Open the Command Palette (`Ctrl+Shift+P`).
  2. Type `Depramanger: Check Current File Imports` and select it.
  3. The extension will check the current file for imports and install missing dependencies.

## Configuration

The extension uses predefined configurations for each supported language. These configurations include:

- **Dependency Files**: Files where dependencies are declared (e.g., `requirements.txt` for Python, `package.json` for Node.js).
- **Common Folders**: Folders where dependencies are typically installed (e.g., `node_modules` for Node.js).
- **Parser**: Function to parse dependency files and extract declared dependencies.
- **Installed Dependencies**: Function to retrieve installed dependencies from the workspace.
- **Required Extensions**: Recommended VSCode extensions for the language.
- **Install Command**: Command to install a dependency.
- **Primary Dependency File**: The main file where dependencies are declared.
- **Version Check**: Functions to get the current and latest versions of a dependency.
- **Update Dependency**: Function to update a dependency in the primary dependency file.

## Compilation

To compile the extension, run the following command in the terminal:

```sh
vsce package
```

Then to install the extension, run the following command in the terminal:

```sh
code --install-extension depramanager-1.1.0.vsix
```

## Contributing

Contributions are welcome! If you find any issues or have suggestions for improvement, please open an issue or submit a pull request on the extension's GitHub repository.

## License

This extension is licensed under the Apache 2 License. See the LICENSE file for more information.

## Notes

You can see also a nvim port i created here https://github.com/Okerew/OkerewConfig.
