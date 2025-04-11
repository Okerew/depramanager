import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import * as https from "https";
import { exec } from "child_process";

interface VersionInfo {
  current: string;
  latest: string;
  name: string;
}

interface Vulnerability {
  id: string;
  title: string;
  description: string;
  severity: string;
  package: string;
  version: string;
  fixedVersion?: string;
}

interface DependencyNode {
  name: string;
  version: string;
  dependencies: Map<string, DependencyNode>;
}

interface LanguageConfig {
  name: string;
  dependencyFiles: string[];
  commonFolders: string[];
  parser: (content: string) => string[];
  getInstalledDeps: (folderPath: string) => string[];
  requiredExtensions: string[];
  installCommand: (dep: string) => string;
  addToDependencyFile: (filePath: string, deps: string[]) => void;
  getPrimaryDependencyFile: () => string;
  getLatestVersion: (dep: string) => Promise<string>;
  getCurrentVersion: (dep: string, folderPath: string) => string;
  updateDependency: (dep: string, version: string, filePath: string) => void;
  getVulnerabilities: (
    dep: string,
    version: string
  ) => Promise<Vulnerability[]>;
  getSubDependencies: (
    dep: string,
    version: string
  ) => Promise<Map<string, string>>;
}

interface DependencyAnalysis {
  declared: Set<string>;
  installed: Set<string>;
  missing: Set<string>;
  extra: Set<string>;
  missingExtensions: string[];
}

const languageConfigs: LanguageConfig[] = [
  {
    name: "Python",
    dependencyFiles: [
      "requirements.txt",
      "Pipfile",
      "pyproject.toml",
      "setup.py",
    ],
    commonFolders: ["venv", "env", ".venv", ".env", "virtualenv"],
    parser: (content: string) => {
      return content
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => line.split("==")[0].trim());
    },
    getInstalledDeps: (folderPath: string) => {
      for (const venvFolder of ["venv", "env", ".venv", ".env", "virtualenv"]) {
        const sitePackagesPath = path.join(
          folderPath,
          venvFolder,
          "Lib",
          "site-packages"
        );
        if (fs.existsSync(sitePackagesPath)) {
          return fs
            .readdirSync(sitePackagesPath)
            .filter(
              (name) =>
                !name.endsWith(".dist-info") && !name.endsWith(".egg-info")
            )
            .map((name) => name.split("-")[0]);
        }
      }
      return [];
    },
    requiredExtensions: ["ms-python.python", "ms-python.vscode-pylance"],
    installCommand: (dep: string) => `pip install ${dep}`,
    getPrimaryDependencyFile: () => "requirements.txt",
    addToDependencyFile: (filePath: string, deps: string[]) => {
      const content = fs.existsSync(filePath)
        ? fs.readFileSync(filePath, "utf-8")
        : "";
      const newDeps = deps.map((dep) => `${dep}\n`).join("");
      fs.writeFileSync(filePath, content + newDeps);
    },
    getLatestVersion: async (dep: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        https
          .get(`https://pypi.org/pypi/${dep}/json`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                const json = JSON.parse(data);
                resolve(json.info.version);
              } catch (error) {
                reject(error);
              }
            });
          })
          .on("error", reject);
      });
    },
    getCurrentVersion: (dep: string, folderPath: string): string => {
      const reqFile = path.join(folderPath, "requirements.txt");
      if (fs.existsSync(reqFile)) {
        const content = fs.readFileSync(reqFile, "utf-8");
        const match = content.match(new RegExp(`${dep}==([\\d\\.]+)`));
        return match ? match[1] : "";
      }
      return "";
    },
    updateDependency: (dep: string, version: string, filePath: string) => {
      const content = fs.readFileSync(filePath, "utf-8");
      const updated = content.replace(
        new RegExp(`${dep}==([\\d\\.]+)`),
        `${dep}==${version}`
      );
      fs.writeFileSync(filePath, updated);
    },
    getVulnerabilities: async (
      dep: string,
      version: string
    ): Promise<Vulnerability[]> => {
      try {
        const response = await fetch(
          `https://pypi.org/pypi/${dep}/${version}/json`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const jsonData = await response.json();
        const vulns = jsonData.vulnerabilities || [];

        return vulns.map((vuln: any) => ({
          id: vuln.id,
          title: vuln.advisory,
          description: vuln.description,
          severity: vuln.severity,
          package: dep,
          version: version,
          fixedVersion: vuln.fixed_in,
        }));
      } catch (error) {
        console.error(
          `Error fetching vulnerabilities for ${dep}@${version}:`,
          error
        );
        return [];
      }
    },
    getSubDependencies: async (
      dep: string,
      version: string
    ): Promise<Map<string, string>> => {
      try {
        const response = await fetch(
          `https://pypi.org/pypi/${dep}/${version}/json`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        const requires = data.info.requires_dist || [];
        const subDeps = new Map<string, string>();

        for (const req of requires) {
          // Parse requirement string (e.g., "requests (>=2.22.0)")
          const match = req.match(/^([^(]+)(?:\s*\((.*?)\))?/);
          if (match) {
            const [, name, version = "latest"] = match;
            subDeps.set(name.trim(), version.replace(/[>=<~^]/g, "").trim());
          }
        }

        return subDeps;
      } catch (error) {
        console.error(`Error fetching sub-dependencies for ${dep}:`, error);
        return new Map();
      }
    },
  },
  {
    name: "Node.js",
    dependencyFiles: ["package.json", "package-lock.json", "yarn.lock"],
    commonFolders: ["node_modules"],
    parser: (content: string) => {
      try {
        const pkg = JSON.parse(content);
        return [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ];
      } catch {
        return [];
      }
    },
    getInstalledDeps: (folderPath: string) => {
      const nodeModulesPath = path.join(folderPath, "node_modules");
      if (fs.existsSync(nodeModulesPath)) {
        return fs
          .readdirSync(nodeModulesPath)
          .filter((name) => !name.startsWith("."));
      }
      return [];
    },
    requiredExtensions: ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"],
    installCommand: (dep: string) => `npm install ${dep}`,
    getPrimaryDependencyFile: () => "package.json",
    addToDependencyFile: (filePath: string, deps: string[]) => {
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      content.dependencies = content.dependencies || {};
      deps.forEach((dep) => {
        content.dependencies[dep] = "*";
      });
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    },
    getLatestVersion: async (dep: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        https
          .get(`https://registry.npmjs.org/${dep}/latest`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                const json = JSON.parse(data);
                resolve(json.version);
              } catch (error) {
                reject(error);
              }
            });
          })
          .on("error", reject);
      });
    },
    getCurrentVersion: (dep: string, folderPath: string): string => {
      const pkgFile = path.join(folderPath, "package.json");
      if (fs.existsSync(pkgFile)) {
        const content = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
        return (
          content.dependencies?.[dep] ||
          content.devDependencies?.[dep] ||
          ""
        ).replace("^", "");
      }
      return "";
    },
    updateDependency: (dep: string, version: string, filePath: string) => {
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (content.dependencies?.[dep]) {
        content.dependencies[dep] = `^${version}`;
      } else if (content.devDependencies?.[dep]) {
        content.devDependencies[dep] = `^${version}`;
      }
      fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    },
    getVulnerabilities: async (
      dep: string,
      version: string
    ): Promise<Vulnerability[]> => {
      try {
        const response = await fetch(
          `https://registry.npmjs.org/-/npm/v1/security/advisories/${dep}`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const jsonData = await response.json();
        const vulns = jsonData.advisories || [];

        return vulns
          .filter((vuln: any) => {
            const affectedVersions = vuln.vulnerable_versions.split("||");
            return affectedVersions.some((v: string) => v.includes(version));
          })
          .map((vuln: any) => ({
            id: vuln.id,
            title: vuln.title,
            description: vuln.overview,
            severity: vuln.severity,
            package: dep,
            version: version,
            fixedVersion: vuln.patched_versions?.[0] || null,
          }));
      } catch (error) {
        console.error(`Error fetching vulnerabilities for ${dep}:`, error);
        return [];
      }
    },
    getSubDependencies: async (
      dep: string,
      version: string
    ): Promise<Map<string, string>> => {
      try {
        const response = await fetch(
          `https://registry.npmjs.org/${dep}/${version}`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        const subDeps = new Map<string, string>();

        if (data.dependencies) {
          Object.entries(data.dependencies).forEach(([name, version]) => {
            subDeps.set(name, (version as string).replace(/[>=<~^]/g, ""));
          });
        }

        return subDeps;
      } catch (error) {
        console.error(`Error fetching sub-dependencies for ${dep}:`, error);
        return new Map();
      }
    },
  },
  {
    name: "Go",
    dependencyFiles: ["go.mod", "go.sum"],
    commonFolders: ["vendor"],
    parser: (content: string) => {
      return content
        .split("\n")
        .filter((line) => line.startsWith("require"))
        .map((line) => line.split(" ")[1]);
    },
    getInstalledDeps: (folderPath: string) => {
      const vendorPath = path.join(folderPath, "vendor");
      if (fs.existsSync(vendorPath)) {
        const getVendorDeps = (dir: string): string[] => {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => {
              const fullPath = path.join(dir, dirent.name);
              if (
                fs.readdirSync(fullPath).some((file) => file.endsWith(".go"))
              ) {
                return dirent.name;
              }
              return getVendorDeps(fullPath);
            })
            .flat();
        };
        return getVendorDeps(vendorPath);
      }
      return [];
    },
    requiredExtensions: ["golang.go"],
    installCommand: (dep: string) => `go get ${dep}`,
    getPrimaryDependencyFile: () => "go.mod",
    addToDependencyFile: (filePath: string, deps: string[]) => {
      const content = fs.readFileSync(filePath, "utf-8");
      const newDeps = deps.map((dep) => `require ${dep} v0.0.0\n`).join("");
      fs.writeFileSync(filePath, content + newDeps);
    },
    getLatestVersion: async (dep: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        https
          .get(`https://proxy.golang.org/${dep}/@v/list`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                const versions = data.trim().split("\n");
                resolve(versions[versions.length - 1]);
              } catch (error) {
                reject(error);
              }
            });
          })
          .on("error", reject);
      });
    },
    getCurrentVersion: (dep: string, folderPath: string): string => {
      const modFile = path.join(folderPath, "go.mod");
      if (fs.existsSync(modFile)) {
        const content = fs.readFileSync(modFile, "utf-8");
        const match = content.match(new RegExp(`${dep} v([\\d\\.]+)`));
        return match ? match[1] : "";
      }
      return "";
    },
    updateDependency: (dep: string, version: string, filePath: string) => {
      const content = fs.readFileSync(filePath, "utf-8");
      const updated = content.replace(
        new RegExp(`${dep} v[\\d\\.]+`),
        `${dep} v${version}`
      );
      fs.writeFileSync(filePath, updated);
    },
    getVulnerabilities: async (
      dep: string,
      version: string
    ): Promise<Vulnerability[]> => {
      try {
        const response = await fetch(
          `https://vuln.go.dev/v1/vulnerabilities/${dep}`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const jsonData = await response.json();
        const vulns = jsonData.vulnerabilities || [];

        return vulns
          .filter((vuln: any) => {
            const affectedVersions = vuln.affected_versions.split("||");
            return affectedVersions.some((v: string) => v.includes(version));
          })
          .map((vuln: any) => ({
            id: vuln.id,
            title: vuln.title,
            description: vuln.description,
            severity: vuln.severity,
            package: dep,
            version: version,
            fixedVersion: vuln.fixed_versions?.[0] || null,
          }));
      } catch (error) {
        console.error(`Error fetching vulnerabilities for ${dep}:`, error);
        return [];
      }
    },
    getSubDependencies: async (
      dep: string,
      version: string
    ): Promise<Map<string, string>> => {
      try {
        const response = await fetch(
          `https://proxy.golang.org/${dep}/@v/${version}.info`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        const subDeps = new Map<string, string>();

        if (data.Deps) {
          data.Deps.forEach((dep: any) => {
            subDeps.set(dep.Path, dep.Version);
          });
        }

        return subDeps;
      } catch (error) {
        console.error(`Error fetching sub-dependencies for ${dep}:`, error);
        return new Map();
      }
    },
  },
  {
    name: "Rust",
    dependencyFiles: ["Cargo.toml", "Cargo.lock"],
    commonFolders: ["target"],
    parser: (content: string) => {
      const depSection = content.split("[dependencies]")[1];
      return depSection
        ? depSection
            .split("\n")
            .filter((line) => line.includes("="))
            .map((line) => line.split("=")[0].trim())
        : [];
    },
    getInstalledDeps: (folderPath: string) => {
      const targetPath = path.join(folderPath, "target");
      if (fs.existsSync(targetPath)) {
        const depsPath = path.join(targetPath, "debug", "deps");
        if (fs.existsSync(depsPath)) {
          return fs
            .readdirSync(depsPath)
            .filter((name) => name.endsWith(".rlib"))
            .map((name) => name.split("-")[0]);
        }
      }
      return [];
    },
    requiredExtensions: ["rust-lang.rust-analyzer"],
    installCommand: (dep: string) => `cargo add ${dep}`,
    getPrimaryDependencyFile: () => "Cargo.toml",
    addToDependencyFile: (filePath: string, deps: string[]) => {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!content.includes("[dependencies]")) {
        fs.appendFileSync(filePath, "\n[dependencies]\n");
      }
      const newDeps = deps.map((dep) => `${dep} = "*"\n`).join("");
      fs.appendFileSync(filePath, newDeps);
    },
    getLatestVersion: async (dep: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        https
          .get(`https://crates.io/api/v1/crates/${dep}`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                const json = JSON.parse(data);
                resolve(json.crate.max_version);
              } catch (error) {
                reject(error);
              }
            });
          })
          .on("error", reject);
      });
    },
    getCurrentVersion: (dep: string, folderPath: string): string => {
      const cargoFile = path.join(folderPath, "Cargo.toml");
      if (fs.existsSync(cargoFile)) {
        const content = fs.readFileSync(cargoFile, "utf-8");
        const match = content.match(new RegExp(`${dep}\\s*=\\s*"([\\d\\.]+)"`));
        return match ? match[1] : "";
      }
      return "";
    },
    updateDependency: (dep: string, version: string, filePath: string) => {
      const content = fs.readFileSync(filePath, "utf-8");
      const updated = content.replace(
        new RegExp(`${dep}\\s*=\\s*"[\\d\\.]+")`),
        `${dep} = "${version}"`
      );
      fs.writeFileSync(filePath, updated);
    },
    getVulnerabilities: async (
      dep: string,
      version: string
    ): Promise<Vulnerability[]> => {
      try {
        const response = await fetch(
          `https://crates.io/api/v1/crates/${dep}/vulnerabilities`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const jsonData = await response.json();
        const vulns = jsonData.vulnerabilities || [];

        return vulns
          .filter((vuln: any) => {
            const affectedVersions = vuln.affected_versions.split("||");
            return affectedVersions.some((v: string) => v.includes(version));
          })
          .map((vuln: any) => ({
            id: vuln.id,
            title: vuln.title,
            description: vuln.description,
            severity: vuln.severity,
            package: dep,
            version: version,
            fixedVersion: vuln.fixed_versions?.[0] || null,
          }));
      } catch (error) {
        console.error(`Error fetching vulnerabilities for ${dep}:`, error);
        return [];
      }
    },
    getSubDependencies: async (
      dep: string,
      version: string
    ): Promise<Map<string, string>> => {
      try {
        const response = await fetch(
          `https://crates.io/api/v1/crates/${dep}/${version}`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        const subDeps = new Map<string, string>();

        if (data.dependencies) {
          data.dependencies.forEach((dep: any) => {
            subDeps.set(dep.name, dep.req);
          });
        }

        return subDeps;
      } catch (error) {
        console.error(`Error fetching sub-dependencies for ${dep}:`, error);
        return new Map();
      }
    },
  },
  {
    name: "PHP",
    dependencyFiles: ["composer.json", "composer.lock"],
    commonFolders: ["vendor"],
    parser: (content: string) => {
      try {
        const pkg = JSON.parse(content);
        return [
          ...Object.keys(pkg.require || {}),
          ...Object.keys(pkg["require-dev"] || {}),
        ].filter((dep) => !dep.startsWith("php") && !dep.startsWith("ext-"));
      } catch {
        return [];
      }
    },
    getInstalledDeps: (folderPath: string) => {
      const vendorPath = path.join(folderPath, "vendor");
      if (fs.existsSync(vendorPath)) {
        const getComposerDeps = (dir: string): string[] => {
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter(
              (dirent) => dirent.isDirectory() && !dirent.name.startsWith(".")
            )
            .map((dirent) => {
              const fullPath = path.join(dir, dirent.name);
              const composerJson = path.join(fullPath, "composer.json");
              if (fs.existsSync(composerJson)) {
                try {
                  const content = JSON.parse(
                    fs.readFileSync(composerJson, "utf-8")
                  );
                  return content.name || dirent.name;
                } catch {
                  return dirent.name;
                }
              }
              return getComposerDeps(fullPath);
            })
            .flat();
        };
        return getComposerDeps(vendorPath);
      }
      return [];
    },
    requiredExtensions: [
      "bmewburn.vscode-intelephense-client",
      "xdebug.php-debug",
    ],
    installCommand: (dep: string) => `composer require ${dep}`,
    getPrimaryDependencyFile: () => "composer.json",
    addToDependencyFile: (filePath: string, deps: string[]) => {
      const content = fs.existsSync(filePath)
        ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
        : { require: {} };

      content.require = content.require || {};
      deps.forEach((dep) => {
        content.require[dep] = "*";
      });

      fs.writeFileSync(filePath, JSON.stringify(content, null, 4));
    },
    getLatestVersion: async (dep: string): Promise<string> => {
      return new Promise((resolve, reject) => {
        https
          .get(`https://repo.packagist.org/p2/${dep}.json`, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              try {
                const json = JSON.parse(data);
                const versions = Object.keys(json.packages[dep]).filter(
                  (v) =>
                    !v.includes("-dev") &&
                    !v.includes("-alpha") &&
                    !v.includes("-beta") &&
                    !v.includes("-RC")
                );
                resolve(versions[0] || "");
              } catch (error) {
                reject(error);
              }
            });
          })
          .on("error", reject);
      });
    },
    getCurrentVersion: (dep: string, folderPath: string): string => {
      const composerFile = path.join(folderPath, "composer.json");
      if (fs.existsSync(composerFile)) {
        const content = JSON.parse(fs.readFileSync(composerFile, "utf-8"));
        return (content.require?.[dep] || content["require-dev"]?.[dep] || "")
          .replace("^", "")
          .replace("~", "");
      }
      return "";
    },
    updateDependency: (dep: string, version: string, filePath: string) => {
      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (content.require?.[dep]) {
        content.require[dep] = `^${version}`;
      } else if (content["require-dev"]?.[dep]) {
        content["require-dev"][dep] = `^${version}`;
      }
      fs.writeFileSync(filePath, JSON.stringify(content, null, 4));
    },
    getVulnerabilities: async (
      dep: string,
      version: string
    ): Promise<Vulnerability[]> => {
      try {
        const response = await fetch(
          `https://packagist.org/packages/${dep}/vulnerabilities`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const jsonData = await response.json();
        const vulns = jsonData.vulnerabilities || [];

        return vulns
          .filter((vuln: any) => {
            const affectedVersions = vuln.affected_versions.split("||");
            return affectedVersions.some((v: string) => v.includes(version));
          })
          .map((vuln: any) => ({
            id: vuln.id,
            title: vuln.title,
            description: vuln.description,
            severity: vuln.severity,
            package: dep,
            version: version,
            fixedVersion: vuln.fixed_versions?.[0] || null,
          }));
      } catch (error) {
        console.error(`Error fetching vulnerabilities for ${dep}:`, error);
        return [];
      }
    },
    getSubDependencies: async (
      dep: string,
      version: string
    ): Promise<Map<string, string>> => {
      try {
        const response = await fetch(
          `https://packagist.org/packages/${dep}/json`
        );
        if (!response.ok) {
          throw new Error(
            `Failed to fetch data: ${response.status} ${response.statusText}`
          );
        }

        const data = await response.json();
        const subDeps = new Map<string, string>();

        if (data.package.dependencies) {
          data.package.dependencies.forEach((dep: any) => {
            subDeps.set(dep.name, dep.version);
          });
        }

        return subDeps;
      } catch (error) {
        console.error(`Error fetching sub-dependencies for ${dep}:`, error);
        return new Map();
      }
    },
  },
];

interface DependencyInfo {
  name: string;
  version?: string;
}

interface LanguageQuickPickItem extends vscode.QuickPickItem {
  config: LanguageConfig;
}

interface DependencyQuickPickItem extends vscode.QuickPickItem {
  dependency: DependencyInfo;
}

interface ImportAnalysisResult {
  detectedImports: Set<string>;
  missingImports: string[];
  language: string;
}

class DependencyAnalyzer {
  private async findFiles(
    folderPath: string,
    patterns: string[]
  ): Promise<string[]> {
    const files: string[] = [];

    for (const pattern of patterns) {
      const results = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folderPath, `**/${pattern}`),
        "**/node_modules/**"
      );
      files.push(...results.map((uri) => uri.fsPath));
    }

    return files;
  }

  private async checkExtensions(
    requiredExtensions: string[]
  ): Promise<string[]> {
    const missingExtensions: string[] = [];
    for (const extId of requiredExtensions) {
      const extension = vscode.extensions.getExtension(extId);
      if (!extension) {
        missingExtensions.push(extId);
      }
    }
    return missingExtensions;
  }

  private async promptForInstallation(
    dep: string,
    language: string
  ): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `Missing dependency for ${language}: ${dep}`,
      {
        modal: false,
        detail: `Would you like to install this dependency?`,
      },
      "Install",
      "Skip"
    );
    return choice === "Install";
  }

  private async promptForExtensionInstallation(
    extId: string,
    language: string
  ): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `Missing recommended extension for ${language}: ${extId}`,
      {
        modal: false,
        detail: `This extension is recommended for ${language} development.`,
      },
      "Install",
      "Skip"
    );
    return choice === "Install";
  }

  private async installDependency(
    workspacePath: string,
    dep: string,
    command: string,
    language: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing ${dep} for ${language}...`,
          cancellable: false,
        },
        async (progress) => {
          try {
            await new Promise<void>((resolveExec, rejectExec) => {
              cp.exec(
                command,
                { cwd: workspacePath },
                (error, stdout, stderr) => {
                  if (error) {
                    rejectExec(error);
                  } else {
                    resolveExec();
                  }
                }
              );
            });

            await vscode.window.showInformationMessage(
              `Successfully installed ${dep}`,
              { modal: false }
            );
            resolve();
          } catch (error) {
            const errorMessage = `Failed to install ${dep}: ${
              (error as Error).message
            }`;
            await vscode.window.showErrorMessage(errorMessage, {
              modal: false,
            });
            reject(new Error(errorMessage));
          }
        }
      );
    });
  }

  private async buildDependencyTree(
    dep: string,
    version: string,
    config: LanguageConfig,
    visited: Set<string> = new Set()
  ): Promise<DependencyNode> {
    const key = `${dep}@${version}`;
    if (visited.has(key)) {
      return {
        name: dep,
        version: version,
        dependencies: new Map(),
      };
    }

    visited.add(key);
    const subDeps = await config.getSubDependencies(dep, version);
    const dependencies = new Map<string, DependencyNode>();

    for (const [subDep, subVersion] of subDeps.entries()) {
      dependencies.set(
        subDep,
        await this.buildDependencyTree(subDep, subVersion, config, visited)
      );
    }

    return {
      name: dep,
      version: version,
      dependencies,
    };
  }

  async analyzeDependencyTree(
    workspacePath: string,
    config: LanguageConfig
  ): Promise<Map<string, DependencyNode>> {
    const depTree = new Map<string, DependencyNode>();
    const workspaceFiles = await this.findFiles(
      workspacePath,
      config.dependencyFiles
    );

    for (const file of workspaceFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const deps = config.parser(content);

        for (const dep of deps) {
          const version = config.getCurrentVersion(dep, workspacePath);
          if (version) {
            depTree.set(
              dep,
              await this.buildDependencyTree(dep, version, config)
            );
          }
        }
      } catch (error) {
        console.error(`Error analyzing dependency tree for ${file}:`, error);
      }
    }

    return depTree;
  }

  async analyzeDependencies(
    workspacePath: string
  ): Promise<Map<string, DependencyAnalysis>> {
    const analysisMap = new Map<string, DependencyAnalysis>();

    for (const config of languageConfigs) {
      try {
        const analysis = await this.analyzeLanguageDependencies(
          workspacePath,
          config
        );
        if (analysis) {
          analysisMap.set(config.name, analysis);

          // Handle missing extensions
          for (const extId of analysis.missingExtensions) {
            const shouldInstall = await this.promptForExtensionInstallation(
              extId,
              config.name
            );
            if (shouldInstall) {
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: `Installing extension ${extId}...`,
                  cancellable: false,
                },
                async () => {
                  try {
                    await vscode.commands.executeCommand(
                      "workbench.extensions.installExtension",
                      extId
                    );
                    await vscode.window.showInformationMessage(
                      `Successfully installed extension ${extId}`,
                      { modal: false }
                    );
                  } catch (error) {
                    await vscode.window.showErrorMessage(
                      `Failed to install extension ${extId}: ${
                        (error as Error).message
                      }`,
                      { modal: false }
                    );
                  }
                }
              );
            }
          }

          // Handle missing dependencies
          for (const dep of analysis.missing) {
            const shouldInstall = await this.promptForInstallation(
              dep,
              config.name
            );
            if (shouldInstall) {
              await this.installDependency(
                workspacePath,
                dep,
                config.installCommand(dep),
                config.name
              );
            }
          }
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          `Error analyzing ${config.name} dependencies: ${
            (error as Error).message
          }`,
          { modal: false }
        );
      }
    }

    return analysisMap;
  }

  async analyzeLanguageDependencies(
    workspacePath: string,
    config: LanguageConfig
  ): Promise<DependencyAnalysis | null> {
    const declared = new Set<string>();
    const workspaceFiles = await this.findFiles(
      workspacePath,
      config.dependencyFiles
    );

    for (const file of workspaceFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        config.parser(content).forEach((dep) => declared.add(dep));
      } catch (error) {
        await vscode.window.showWarningMessage(
          `Error reading ${path.basename(file)}: ${(error as Error).message}`,
          { modal: false }
        );
      }
    }

    const installed = new Set(config.getInstalledDeps(workspacePath));
    const missingExtensions = await this.checkExtensions(
      config.requiredExtensions
    );
    const missing = new Set([...declared].filter((dep) => !installed.has(dep)));
    const extra = new Set([...installed].filter((dep) => !declared.has(dep)));

    if (
      declared.size > 0 ||
      installed.size > 0 ||
      missingExtensions.length > 0
    ) {
      return {
        declared,
        installed,
        missing,
        extra,
        missingExtensions,
      };
    }

    return null;
  }

  async syncMissingDeclarations(workspacePath: string): Promise<void> {
    try {
      const analysisMap = await this.analyzeDependencies(workspacePath);
      let syncedAny = false;

      for (const [language, analysis] of analysisMap) {
        const config = languageConfigs.find((c) => c.name === language);
        if (!config) continue;

        const extraDeps = [...analysis.extra];
        if (extraDeps.length > 0) {
          const primaryFile = path.join(
            workspacePath,
            config.getPrimaryDependencyFile()
          );

          if (!fs.existsSync(primaryFile)) {
            const createFile = await vscode.window.showWarningMessage(
              `${config.getPrimaryDependencyFile()} does not exist. Create it?`,
              { modal: true },
              "Yes",
              "No"
            );

            if (createFile === "Yes") {
              fs.writeFileSync(primaryFile, "");
            } else {
              continue;
            }
          }

          try {
            config.addToDependencyFile(primaryFile, extraDeps);
            await vscode.window.showInformationMessage(
              `Added ${
                extraDeps.length
              } dependencies to ${config.getPrimaryDependencyFile()} for ${language}`,
              { modal: false }
            );
            syncedAny = true;
          } catch (error) {
            await vscode.window.showErrorMessage(
              `Failed to add dependencies to ${config.getPrimaryDependencyFile()} for ${language}: ${
                (error as Error).message
              }`,
              { modal: false }
            );
          }
        }
      }

      if (!syncedAny) {
        await vscode.window.showInformationMessage(
          "No missing declarations found to sync.",
          { modal: false }
        );
      }
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Error syncing declarations: ${(error as Error).message}`,
        { modal: true }
      );
    }
  }
  private async checkForUpdates(
    workspacePath: string,
    config: LanguageConfig
  ): Promise<VersionInfo[]> {
    const updates: VersionInfo[] = [];
    const declaredDeps = new Set<string>();

    const workspaceFiles = await this.findFiles(
      workspacePath,
      config.dependencyFiles
    );
    for (const file of workspaceFiles) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        config.parser(content).forEach((dep) => declaredDeps.add(dep));
      } catch (error) {
        console.error(`Error reading ${file}:`, error);
      }
    }

    for (const dep of declaredDeps) {
      try {
        const currentVersion = config.getCurrentVersion(dep, workspacePath);
        const latestVersion = await config.getLatestVersion(dep);

        if (
          currentVersion &&
          latestVersion &&
          currentVersion !== latestVersion
        ) {
          updates.push({
            name: dep,
            current: currentVersion,
            latest: latestVersion,
          });
        }
      } catch (error) {
        console.error(`Error checking versions for ${dep}:`, error);
      }
    }

    return updates;
  }

  async promptForUpdates(workspacePath: string): Promise<void> {
    for (const config of languageConfigs) {
      try {
        const updates = await this.checkForUpdates(workspacePath, config);

        if (updates.length > 0) {
          const items = updates.map((update) => ({
            label: update.name,
            description: `${update.current} → ${update.latest}`,
            update,
          }));

          const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `Select ${config.name} dependencies to update`,
          });

          if (selected && selected.length > 0) {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Updating dependencies...",
                cancellable: false,
              },
              async () => {
                for (const item of selected) {
                  const { update } = item;
                  const primaryFile = path.join(
                    workspacePath,
                    config.getPrimaryDependencyFile()
                  );

                  try {
                    config.updateDependency(
                      update.name,
                      update.latest,
                      primaryFile
                    );
                    await this.installDependency(
                      workspacePath,
                      update.name,
                      config.installCommand(update.name),
                      config.name
                    );
                  } catch (error) {
                    vscode.window.showErrorMessage(
                      `Failed to update ${update.name}: ${
                        (error as Error).message
                      }`
                    );
                  }
                }
              }
            );

            vscode.window.showInformationMessage(
              `Successfully updated ${selected.length} dependencies!`
            );
          }
        } else {
          vscode.window.showInformationMessage(
            `All ${config.name} dependencies are up to date!`
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Error checking for ${config.name} updates: ${
            (error as Error).message
          }`
        );
      }
    }
  }

  async installSpecificDependency(workspacePath: string): Promise<void> {
    // First, let user select the language
    const languageItems = languageConfigs.map((config) => ({
      label: config.name,
      description: `Install dependency for ${config.name}`,
      config: config,
    }));

    const selectedLanguage = await vscode.window.showQuickPick(languageItems, {
      placeHolder: "Select programming language",
      title: "Install Dependency",
    });

    if (!selectedLanguage) {
      return; // User cancelled
    }

    // Then, prompt for dependency name
    const dependencyName = await vscode.window.showInputBox({
      placeHolder: "Enter dependency name",
      prompt: `Enter the name of the ${selectedLanguage.label} dependency you want to install`,
      title: "Dependency Name",
    });

    if (!dependencyName) {
      return; // User cancelled
    }

    const config = selectedLanguage.config;
    const primaryFile = path.join(
      workspacePath,
      config.getPrimaryDependencyFile()
    );

    // Check if dependency file exists
    if (!fs.existsSync(primaryFile)) {
      const createFile = await vscode.window.showWarningMessage(
        `${config.getPrimaryDependencyFile()} does not exist. Create it?`,
        { modal: true },
        "Yes",
        "No"
      );

      if (createFile === "Yes") {
        // Create file with appropriate initial content
        switch (config.name) {
          case "Node.js":
            fs.writeFileSync(
              primaryFile,
              JSON.stringify(
                {
                  name: path.basename(workspacePath),
                  version: "1.0.0",
                  dependencies: {},
                },
                null,
                2
              )
            );
            break;
          case "PHP":
            fs.writeFileSync(
              primaryFile,
              JSON.stringify(
                {
                  name: path.basename(workspacePath),
                  require: {},
                },
                null,
                2
              )
            );
            break;
          default:
            fs.writeFileSync(primaryFile, "");
        }
      } else {
        return;
      }
    }

    // Install the dependency
    try {
      await this.installDependency(
        workspacePath,
        dependencyName,
        config.installCommand(dependencyName),
        config.name
      );

      // Add to dependency file
      config.addToDependencyFile(primaryFile, [dependencyName]);

      await vscode.window.showInformationMessage(
        `Successfully installed ${dependencyName} and added to ${config.getPrimaryDependencyFile()}`,
        { modal: false }
      );
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Failed to install ${dependencyName}: ${(error as Error).message}`,
        { modal: false }
      );
    }
  }
  async scanVulnerabilities(
    workspacePath: string
  ): Promise<Map<string, Vulnerability[]>> {
    const vulnerabilityMap = new Map<string, Vulnerability[]>();

    for (const config of languageConfigs) {
      try {
        const workspaceFiles = await this.findFiles(
          workspacePath,
          config.dependencyFiles
        );
        const declaredDeps = new Set<string>();

        for (const file of workspaceFiles) {
          const content = fs.readFileSync(file, "utf-8");
          config.parser(content).forEach((dep) => declaredDeps.add(dep));
        }

        for (const dep of declaredDeps) {
          const currentVersion = config.getCurrentVersion(dep, workspacePath);
          if (currentVersion) {
            const vulnerabilities = await config.getVulnerabilities(
              dep,
              currentVersion
            );
            if (vulnerabilities.length > 0) {
              vulnerabilityMap.set(`${config.name}:${dep}`, vulnerabilities);
            }
          }
        }
      } catch (error) {
        console.error(
          `Error scanning vulnerabilities for ${config.name}:`,
          error
        );
      }
    }

    return vulnerabilityMap;
  }
  async uninstallSpecificDependency(folderPath: string): Promise<void> {
    // First, let user select the language with proper typing
    const languageQuickPick =
      await vscode.window.showQuickPick<LanguageQuickPickItem>(
        languageConfigs.map((config) => ({
          label: config.name,
          description: `Uninstall ${config.name} dependencies`,
          config: config,
        })),
        {
          placeHolder: "Select the language/framework",
          matchOnDescription: true,
          matchOnDetail: true,
        }
      );

    if (!languageQuickPick) {
      return;
    }

    const config = languageQuickPick.config;

    try {
      // Get installed dependencies for the selected language
      const installedDeps = await this.getInstalledDependencies(
        folderPath,
        config
      );

      if (!installedDeps || installedDeps.length === 0) {
        vscode.window.showInformationMessage(
          `No ${config.name} dependencies found to uninstall.`
        );
        return;
      }

      // Let user select dependencies to uninstall with proper typing
      const depToUninstall =
        await vscode.window.showQuickPick<DependencyQuickPickItem>(
          installedDeps.map((dep) => ({
            label: dep.name,
            description: dep.version
              ? `Current version: ${dep.version}`
              : undefined,
            dependency: dep,
          })),
          {
            placeHolder: "Select dependency to uninstall",
            matchOnDescription: true,
            matchOnDetail: true,
          }
        );

      if (!depToUninstall) {
        return;
      }

      // Execute uninstall command based on language
      const terminal = vscode.window.createTerminal(
        `Uninstall ${depToUninstall.dependency.name}`
      );

      let uninstallCommand: string;
      switch (config.name.toLowerCase()) {
        case "python":
          uninstallCommand = `pip uninstall ${depToUninstall.dependency.name} -y`;
          break;
        case "php":
          uninstallCommand = `composer remove ${depToUninstall.dependency.name}`;
          break;
        case "javascript":
        case "nodejs":
          const hasYarnLock = fs.existsSync(path.join(folderPath, "yarn.lock"));
          uninstallCommand = hasYarnLock
            ? `yarn remove ${depToUninstall.dependency.name}`
            : `npm uninstall ${depToUninstall.dependency.name}`;
          break;
        case "rust":
          vscode.window.showInformationMessage(
            `For Rust projects, please remove the dependency "${depToUninstall.dependency.name}" from your Cargo.toml file and run "cargo build" to update dependencies.`
          );
          return;
        case "go":
          uninstallCommand = `go mod edit -droprequire=${depToUninstall.dependency.name} && go mod tidy`;
          break;
        default:
          vscode.window.showErrorMessage(
            `Uninstall command not implemented for ${config.name}`
          );
          return;
      }

      terminal.sendText(`cd "${folderPath}"`);
      terminal.sendText(uninstallCommand);
      terminal.show();

      vscode.window.showInformationMessage(
        `Uninstalling ${depToUninstall.dependency.name}... Check the terminal for progress.`
      );
    } catch (error) {
      vscode.window.showErrorMessage(
        `Error uninstalling dependency: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async execCommand(command: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }

  private async getInstalledDependencies(
    folderPath: string,
    config: LanguageConfig
  ): Promise<DependencyInfo[]> {
    switch (config.name.toLowerCase()) {
      case "python":
        const pipList = await this.execCommand(
          "pip list --format=json",
          folderPath
        );
        return JSON.parse(pipList).map((dep: any) => ({
          name: dep.name,
          version: dep.version,
        }));

      case "php":
        const composerJson = JSON.parse(
          await fs.promises.readFile(
            path.join(folderPath, "composer.json"),
            "utf8"
          )
        );
        return [
          ...Object.keys(composerJson.require || {}).map((name) => ({
            name,
            version: composerJson.require[name],
          })),
          ...Object.keys(composerJson["require-dev"] || {}).map((name) => ({
            name,
            version: composerJson["require-dev"][name],
          })),
        ];

      case "javascript":
      case "nodejs":
        const packageJson = JSON.parse(
          await fs.promises.readFile(
            path.join(folderPath, "package.json"),
            "utf8"
          )
        );
        return [
          ...Object.keys(packageJson.dependencies || {}).map((name) => ({
            name,
            version: packageJson.dependencies[name],
          })),
          ...Object.keys(packageJson.devDependencies || {}).map((name) => ({
            name,
            version: packageJson.devDependencies[name],
          })),
        ];

      case "rust":
        const cargoToml = await fs.promises.readFile(
          path.join(folderPath, "Cargo.toml"),
          "utf8"
        );
        const dependencies = cargoToml.match(
          /^\[dependencies\]([\s\S]*?)(\[|$)/m
        );
        if (!dependencies) return [];

        return dependencies[1]
          .split("\n")
          .filter((line) => line.trim() && !line.trim().startsWith("#"))
          .map((line) => {
            const [name, version] = line.split("=").map((s) => s.trim());
            return { name, version: version?.replace(/['"]/g, "") };
          });

      case "go":
        const modList = await this.execCommand("go list -m all", folderPath);
        return modList
          .split("\n")
          .filter((line) => line && !line.startsWith("go "))
          .map((line) => {
            const [name, version] = line.split(" ");
            return { name, version };
          });

      default:
        return [];
    }
  }

  async analyzeCurrentFileImports(): Promise<ImportAnalysisResult | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("No file is currently open");
      return null;
    }

    const document = editor.document;
    const fileContent = document.getText();
    const fileExtension = path.extname(document.fileName).toLowerCase();
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder found!");
      return null;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;

    // Determine the language based on file extension
    const language = this.getLanguageFromExtension(fileExtension);
    if (!language) {
      vscode.window.showInformationMessage(
        `Unsupported file type: ${fileExtension}`
      );
      return null;
    }

    // Extract imports from the file
    const detectedImports = this.extractImportsFromFile(fileContent, language);

    // Find the corresponding language config
    const config = languageConfigs.find(
      (c) => c.name.toLowerCase() === language.toLowerCase()
    );
    if (!config) {
      return null;
    }

    // Get installed dependencies
    const installed = new Set(config.getInstalledDeps(workspacePath));

    // Find missing imports
    const missingImports = [...detectedImports].filter(
      (importName) =>
        !installed.has(this.normalizeImportName(importName, language))
    );

    return {
      detectedImports,
      missingImports,
      language,
    };
  }

  async installMissingImports(): Promise<void> {
    const analysis = await this.analyzeCurrentFileImports();
    if (!analysis || analysis.missingImports.length === 0) {
      vscode.window.showInformationMessage(
        "No missing imports detected in the current file"
      );
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      vscode.window.showErrorMessage("No workspace folder found!");
      return;
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const config = languageConfigs.find(
      (c) => c.name.toLowerCase() === analysis.language.toLowerCase()
    );
    if (!config) {
      vscode.window.showErrorMessage(
        `Language configuration not found for ${analysis.language}`
      );
      return;
    }

    // Ask user which imports to install
    const selectedImports = await vscode.window.showQuickPick(
      analysis.missingImports.map((imp) => ({
        label: imp,
        picked: true,
      })),
      {
        canPickMany: true,
        placeHolder: "Select missing imports to install",
      }
    );

    if (!selectedImports || selectedImports.length === 0) {
      return;
    }

    const importsToInstall = selectedImports.map((item) => item.label);
    const installedPackages = [];

    // Install each missing import individually
    for (const importName of importsToInstall) {
      // For Python, make some package name adjustments
      const normalizedName = this.normalizeImportName(
        importName,
        analysis.language
      );

      try {
        await this.installDependency(
          workspacePath,
          normalizedName,
          config.installCommand(normalizedName),
          config.name
        );

        installedPackages.push(normalizedName);

        // Add to dependency file if needed (for Python: requirements.txt)
        if (analysis.language.toLowerCase() === "python") {
          const primaryFile = path.join(
            workspacePath,
            config.getPrimaryDependencyFile()
          );
          if (fs.existsSync(primaryFile)) {
            config.addToDependencyFile(primaryFile, [normalizedName]);
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to install ${normalizedName}: ${(error as Error).message}`
        );
      }
    }

    vscode.window.showInformationMessage(
      `Successfully installed ${
        installedPackages.length
      } packages: ${installedPackages.join(", ")}`
    );
  }

  private extractImportsFromFile(
    content: string,
    language: string
  ): Set<string> {
    const imports = new Set<string>();

    switch (language.toLowerCase()) {
      case "javascript":
      case "typescript":
      case "nodejs":
        // Match ES6 imports
        const es6Matches = [
          ...content.matchAll(/import\s+.*?from\s+['"]([^'"./][^'"]*)['"]/g),
        ];
        for (const match of es6Matches) {
          const fullImport = match[1];
          this.addJsImport(imports, fullImport);
        }

        // Match CommonJS requires separately
        const cjsMatches = [
          ...content.matchAll(/require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g),
        ];
        for (const match of cjsMatches) {
          const fullImport = match[1];
          this.addJsImport(imports, fullImport);
        }
        break;

      case "python":
        const importLines = content.match(/^\s*import\s+(.+?)($|\n)/gm) || [];
        for (const line of importLines) {
          // Split by commas to handle "import x, y, z"
          const importStatement = line.replace(/^\s*import\s+/, "").trim();
          const moduleList = importStatement.split(",");

          for (const module of moduleList) {
            // Extract just the module name without "as" or additional parts
            const moduleName = module.trim().split(/\s+/)[0].split(".")[0];
            if (moduleName && !this.isPythonStandardLib(moduleName)) {
              imports.add(moduleName);
            }
          }
        }

        // Process "from x import y" statements
        const fromImportLines =
          content.match(/^\s*from\s+(.+?)\s+import/gm) || [];
        for (const line of fromImportLines) {
          const moduleName = line
            .replace(/^\s*from\s+/, "")
            .replace(/\s+import.*$/, "")
            .trim()
            .split(".")[0];

          if (moduleName && !this.isPythonStandardLib(moduleName)) {
            imports.add(moduleName);
          }
        }
        break;

      case "php":
        const phpMatches = [
          ...content.matchAll(/use\s+([A-Za-z0-9_\\]+)(?:;|\s|as)/g),
          ...content.matchAll(/require[_once]*\s*\(\s*['"]([^'"]*)['"]\s*\)/g),
        ];

        for (const match of phpMatches) {
          // Extract namespace (likely corresponding to a Composer package)
          const namespace = match[1].split("\\")[0];
          imports.add(namespace.toLowerCase());
        }
        break;

      case "rust":
        // Match Rust imports
        const rustMatches = content.matchAll(/^\s*use\s+([a-zA-Z0-9_:]+)/gm);

        for (const match of rustMatches) {
          const crate = match[1].split("::")[0];
          if (!this.isRustStandardLib(crate)) {
            imports.add(crate);
          }
        }
        break;

      case "go":
        const goBlocks = content.match(/import\s+\(\s*([\s\S]*?)\s*\)/g) || [];
        for (const block of goBlocks) {
          const importLines = block.match(/"([^"]+)"/g) || [];
          for (const imp of importLines) {
            this.addGoImport(imports, imp.replace(/"/g, ""));
          }
        }

        // Match Go imports - single line style
        const goSingleMatches = content.matchAll(/import\s+"([^"]+)"/g);
        for (const match of goSingleMatches) {
          this.addGoImport(imports, match[1]);
        }
        break;
    }

    return imports;
  }

  private addJsImport(imports: Set<string>, fullImport: string): void {
    if (!fullImport || fullImport.startsWith(".")) return;

    // Handle scoped packages (@org/package)
    if (fullImport.startsWith("@")) {
      const parts = fullImport.split("/");
      if (parts.length >= 2) {
        imports.add(`${parts[0]}/${parts[1]}`);
      }
    } else {
      // Regular packages - just take the first part before any '/'
      const packageName = fullImport.split("/")[0];
      imports.add(packageName);
    }
  }

  private addGoImport(imports: Set<string>, importPath: string): void {
    if (!importPath) return;

    // Skip standard library
    if (
      !importPath.includes(".") ||
      (!importPath.startsWith("github.com") &&
        !importPath.startsWith("gitlab.com") &&
        !importPath.startsWith("golang.org"))
    ) {
      return;
    }

    const parts = importPath.split("/");
    if (parts.length >= 3) {
      imports.add(`${parts[0]}/${parts[1]}/${parts[2]}`);
    }
  }

  private getLanguageFromExtension(extension: string): string | null {
    switch (extension) {
      case ".js":
      case ".jsx":
      case ".ts":
      case ".tsx":
        return "JavaScript";
      case ".py":
        return "Python";
      case ".php":
        return "PHP";
      case ".rs":
        return "Rust";
      case ".go":
        return "Go";
      default:
        return null;
    }
  }

  private isPythonStandardLib(moduleName: string): boolean {
    const stdLibModules = new Set([
      "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio", "asyncore",
      "atexit", "audioop", "base64", "bdb", "binascii", "binhex", "bisect", "builtins",
      "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code",
      "codecs", "codeop", "collections", "colorsys", "compileall", "concurrent",
      "configparser", "contextlib", "contextvars", "copy", "copyreg", "crypt", "csv",
      "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal", "difflib",
      "dis", "distutils", "doctest", "email", "encodings", "ensurepip", "enum",
      "errno", "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions",
      "ftplib", "functools", "gc", "getopt", "getpass", "gettext", "glob", "graphlib",
      "gzip", "hashlib", "heapq", "hmac", "html", "http", "imaplib", "imghdr",
      "importlib", "inspect", "io", "ipaddress", "itertools", "json", "keyword",
      "lib2to3", "linecache", "locale", "logging", "lzma", "mailbox", "mailcap",
      "marshal", "math", "mimetypes", "mmap", "modulefinder", "msilib", "multiprocessing",
      "netrc", "nntplib", "numbers", "operator", "optparse", "os", "ossaudiodev",
      "parser", "pathlib", "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform",
      "plistlib", "poplib", "posix", "pprint", "profile", "pstats", "pty", "pwd",
      "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random", "re", "readline",
      "reprlib", "resource", "rlcompleter", "runpy", "sched", "secrets", "select",
      "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtpd", "smtplib",
      "sndhdr", "socket", "socketserver", "spwd", "sqlite3", "ssl", "stat", "statistics",
      "string", "stringprep", "struct", "subprocess", "sunau", "symtable", "sys",
      "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile", "termios",
      "textwrap", "threading", "time", "timeit", "tkinter", "token", "tokenize",
      "trace", "traceback", "tracemalloc", "tty", "turtle", "turtledemo", "types",
      "typing", "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings",
      "wave", "weakref", "webbrowser", "winreg", "winsound", "wsgiref", "xdrlib",
      "xml", "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib"
    ]);
    return stdLibModules.has(moduleName);
  }
  

  private isRustStandardLib(crateName: string): boolean {
    const stdLibCrates = new Set([
      "std",           // Standard library
      "core",          // Core functionalities without OS features
      "alloc",         // Heap allocation APIs
      "proc_macro",    // Compiler plugins/macros
      "test",          // Rust's internal test harness
      "panic_unwind",  // Panic handling
      "panic_abort",   // Panic handler
      "unwind",        // Exception handling
      "term",          // Terminal color APIs (part of std)
      "getopts",       // Command line argument parsing (was in std, now deprecated)
      "hashbrown",     // Used internally for hash maps
      "rustc_std_workspace_core",
      "rustc_std_workspace_alloc",
      "rustc_std_workspace_std",
      "self"           // Special keyword in Rust
    ]);
    return stdLibCrates.has(crateName);
  }

  private normalizeImportName(importName: string, language: string): string {
    switch (language.toLowerCase()) {
      case 'python':
        // Handle common Python package name mappings
        const pythonPackageMap: Record<string, string> = {
          'pil': 'pillow',
          'cv2': 'opencv-python',
          'sklearn': 'scikit-learn',
        };
        
        const baseName = importName.toLowerCase();
        return pythonPackageMap[baseName] || baseName.replace(/_/g, '-');
      case "rust":
        // Rust crate names usually use hyphens instead of underscores
        return importName.replace(/_/g, "-");
      default:
        return importName;
    }
  }
}

const versionDiagnostics = vscode.languages.createDiagnosticCollection(
  "dependency-versions"
);

async function updateDiagnostics(
  workspacePath: string,
  config: LanguageConfig,
  document: vscode.TextDocument
) {
  const diagnostics: vscode.Diagnostic[] = [];
  const content = document.getText();
  const fileName = path.basename(document.fileName);

  // Only process relevant dependency files
  if (!config.dependencyFiles.includes(fileName)) {
    return;
  }

  // Get all declared dependencies
  const declaredDeps = new Set<string>();
  try {
    config.parser(content).forEach((dep) => declaredDeps.add(dep));
  } catch (error) {
    console.error(`Error parsing ${fileName}:`, error);
    return;
  }

  // Check each dependency for updates
  for (const dep of declaredDeps) {
    try {
      const currentVersion = config.getCurrentVersion(dep, workspacePath);
      const latestVersion = await config.getLatestVersion(dep);

      if (currentVersion && latestVersion && currentVersion !== latestVersion) {
        // Find the position of the version in the file
        let versionRegex: RegExp;
        let lineText: string | undefined;
        let line = 0;
        let startChar = 0;
        let endChar = 0;

        const lines = content.split("\n");

        switch (fileName) {
          case "package.json":
            // Match "dependency": "^1.2.3" or "dependency": "~1.2.3"
            versionRegex = new RegExp(
              `"${dep}":\\s*"[~^]?(${currentVersion})"`
            );
            break;
          case "requirements.txt":
            // Match dependency==1.2.3
            versionRegex = new RegExp(`${dep}==(${currentVersion})`);
            break;
          case "Cargo.toml":
            // Match dependency = "1.2.3"
            versionRegex = new RegExp(`${dep}\\s*=\\s*"(${currentVersion})"`);
            break;
          case "composer.json":
            // Match "dependency": "^1.2.3" or "dependency": "~1.2.3"
            versionRegex = new RegExp(
              `"${dep}":\\s*"[~^]?(${currentVersion})"`
            );
            break;
          case "go.mod":
            // Match require module v1.2.3
            versionRegex = new RegExp(`${dep}\\s+v(${currentVersion})`);
            break;
          default:
            continue;
        }

        // Find the line containing the version
        for (let i = 0; i < lines.length; i++) {
          const match = lines[i].match(versionRegex);
          if (match) {
            line = i;
            lineText = lines[i];
            const versionStart = match.index! + match[0].indexOf(match[1]);
            startChar = versionStart;
            endChar = versionStart + currentVersion.length;
            break;
          }
        }

        if (lineText) {
          const range = new vscode.Range(
            new vscode.Position(line, startChar),
            new vscode.Position(line, endChar)
          );

          const diagnostic = new vscode.Diagnostic(
            range,
            `Update available: ${currentVersion} → ${latestVersion}`,
            vscode.DiagnosticSeverity.Information
          );

          diagnostic.source = "dependency-checker";
          diagnostic.code = {
            value: "update-available",
            target: vscode.Uri.parse(`https://www.npmjs.com/package/${dep}`),
          };

          diagnostics.push(diagnostic);
        }
      }
    } catch (error) {
      console.error(`Error checking versions for ${dep}:`, error);
    }
  }

  versionDiagnostics.set(document.uri, diagnostics);
}

function generateHtml(
  analysisMap: Map<string, DependencyAnalysis>,
  depTrees: Map<string, Map<string, DependencyNode>>,
  analyzer: DependencyAnalyzer
): string {
  return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .search-container {
                    position: sticky;
                    top: 0;
                    background-color: var(--vscode-editor-background);
                    padding: 10px 0;
                    margin-bottom: 20px;
                }
                .search-input {
                    padding: 8px;
                    width: 100%;
                    max-width: 300px;
                    margin-right: 10px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                }
                .dependency-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px;
                    margin: 4px 0;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                }
                .hidden {
                    display: none;
                }
                h2 {
                    color: var(--vscode-textLink-foreground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 8px;
                }
                .section {
                    margin-bottom: 24px;
                }
                /* Enhanced dependency tree styles */
                .dependency-tree {
                    margin: 20px 0;
                    font-family: monospace;
                }
                .tree-root {
                    margin: 24px 0;
                    padding: 16px;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 6px;
                }
                .tree-root h4 {
                    margin: 0 0 12px 0;
                    color: var(--vscode-textLink-foreground);
                    font-size: 1.1em;
                }
                .tree-node {
                    position: relative;
                    padding-left: 24px;
                    margin: 4px 0;
                }
                .tree-node::before {
                    content: "";
                    position: absolute;
                    left: 0;
                    top: 0;
                    bottom: 0;
                    width: 2px;
                    background-color: var(--vscode-panel-border);
                }
                .tree-node::after {
                    content: "";
                    position: absolute;
                    left: 0;
                    top: 50%;
                    width: 12px;
                    height: 2px;
                    background-color: var(--vscode-panel-border);
                }
                .tree-node:last-child::before {
                    height: 50%;
                }
                .tree-node span {
                    display: inline-block;
                    padding: 4px 8px;
                    background-color: var(--vscode-input-background);
                    border-radius: 4px;
                    font-size: 0.9em;
                }
                .tree-node-children {
                    margin-left: 24px;
                }
                /* New styles for nested dependency groups */
                .nested-group {
                    margin: 8px 0;
                    padding: 12px;
                    border-radius: 6px;
                    border: 1px solid transparent;
                }
                .nested-group.level-1 {
                    background-color: color-mix(in slab, var(--vscode-textLink-foreground) 5%, transparent);
                    border-color: color-mix(in slab, var(--vscode-textLink-foreground) 20%, transparent);
                }
                .nested-group.level-2 {
                    background-color: color-mix(in slab, var(--vscode-charts-blue) 5%, transparent);
                    border-color: color-mix(in slab, var(--vscode-charts-blue) 20%, transparent);
                }
                .nested-group.level-3 {
                    background-color: color-mix(in slab, var(--vscode-charts-green) 5%, transparent);
                    border-color: color-mix(in slab, var(--vscode-charts-green) 20%, transparent);
                }
                .nested-group.level-4 {
                    background-color: color-mix(in slab, var(--vscode-charts-purple) 5%, transparent);
                    border-color: color-mix(in slab, var(--vscode-charts-purple) 20%, transparent);
                }
                .nested-group.level-5 {
                    background-color: color-mix(in slab, var(--vscode-charts-orange) 5%, transparent);
                    border-color: color-mix(in slab, var(--vscode-charts-orange) 20%, transparent);
                }
                .nested-header {
                    font-weight: bold;
                    margin-bottom: 8px;
                    color: var(--vscode-textLink-foreground);
                    font-size: 0.9em;
                }
            </style>
            <script>
                function searchDependencies() {
                    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
                    const items = document.getElementsByClassName('dependency-item');

                    for (const item of items) {
                        const depName = item.getAttribute('data-name').toLowerCase();
                        item.classList.toggle('hidden', !depName.includes(searchTerm));
                    }
                }
            </script>
        </head>
        <body>
            <h1>Dependency Analysis Report</h1>
            <div class="search-container">
                <input type="text"
                       id="searchInput"
                       class="search-input"
                       placeholder="Search dependencies..."
                       oninput="searchDependencies()">
            </div>
            ${Array.from(analysisMap.entries())
              .map(
                ([language, analysis]) => `
                <div class="section">
                    <h2>${language}</h2>

                    ${
                      analysis.missingExtensions.length > 0
                        ? `
                        <h3 style="color: var(--vscode-errorForeground);">Missing VS Code Extensions</h3>
                        <ul>${analysis.missingExtensions
                          .map((ext) => `<li>${ext}</li>`)
                          .join("")}</ul>
                    `
                        : ""
                    }

                    <h3>Declared Dependencies (${analysis.declared.size})</h3>
                    <div>${[...analysis.declared]
                      .map(
                        (dep) => `
                        <div class="dependency-item" data-name="${dep}">
                            <span>${dep}</span>
                        </div>
                    `
                      )
                      .join("")}</div>

                    <h3>Installed Dependencies (${analysis.installed.size})</h3>
                    <div>${[...analysis.installed]
                      .map(
                        (dep) => `
                        <div class="dependency-item" data-name="${dep}">
                            <span>${dep}</span>
                        </div>
                    `
                      )
                      .join("")}</div>

                    <h3 style="color: var(--vscode-errorForeground);">Missing Dependencies (${
                      analysis.missing.size
                    })</h3>
                    <ul>${[...analysis.missing]
                      .map((dep) => `<li>${dep}</li>`)
                      .join("")}</ul>

                    <h3 style="color: var(--vscode-warningForeground);">Extra Dependencies (${
                      analysis.extra.size
                    })</h3>
                    <div>${[...analysis.extra]
                      .map(
                        (dep) => `
                        <div class="dependency-item" data-name="${dep}">
                            <span>${dep}</span>
                        </div>
                    `
                      )
                      .join("")}</div>
                </div>
                <h3>Dependency Trees</h3>
                <div class="dependency-tree">
                    ${Array.from(depTrees.get(language) || [])
                      .map(
                        ([dep, tree]) => `
                        <div class="tree-root">
                            <h4>${dep}</h4>
                            ${generateNestedTree(tree, 1)}
                        </div>
                    `
                      )
                      .join("")}
                </div>
            </div>
            `
              )
              .join("")}
        </body>
        </html>
    `;
}

function generateNestedTree(node: DependencyNode, level: number = 1): string {
  if (!node.dependencies || node.dependencies.size === 0) {
    return `
      <div class="tree-node">
        <span>
          <span class="dep-name">${node.name}</span>
          <span class="dep-version">@${node.version}</span>
        </span>
      </div>
    `;
  }

  return `
    <div class="nested-group level-${level}">
      <div class="nested-header">
        <span class="dep-name">${node.name}</span>
        <span class="dep-version">@${node.version}</span>
      </div>
      <div class="tree-node-children">
        ${Array.from(node.dependencies.entries())
          .map(([name, dep]) => generateNestedTree(dep, (level % 5) + 1))
          .join("")}
      </div>
    </div>
  `;
}

function generateVulnerabilityHtml(
  vulnerabilityMap: Map<string, Vulnerability[]>
): string {
  return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { 
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
          }
          .vulnerability-item {
            margin: 20px 0;
            padding: 15px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
          }
          .high { border-left: 4px solid #ff0000; }
          .medium { border-left: 4px solid #ffa500; }
          .low { border-left: 4px solid #ffff00; }
          .severity-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            margin-left: 10px;
          }
          .high-badge { background-color: #ff000033; color: #ff0000; }
          .medium-badge { background-color: #ffa50033; color: #ffa500; }
          .low-badge { background-color: #ffff0033; color: #ffff00; }
        </style>
      </head>
      <body>
        <h1>Vulnerability Report</h1>
        ${Array.from(vulnerabilityMap.entries())
          .map(
            ([key, vulns]) => `
          <div class="package-section">
            <h2>${key}</h2>
            ${vulns
              .map(
                (vuln) => `
              <div class="vulnerability-item ${vuln.severity.toLowerCase()}">
                <h3>
                  ${vuln.title}
                  <span class="severity-badge ${vuln.severity.toLowerCase()}-badge">
                    ${vuln.severity}
                  </span>
                </h3>
                <p><strong>Package:</strong> ${vuln.package}@${vuln.version}</p>
                ${
                  vuln.fixedVersion
                    ? `<p><strong>Fixed in:</strong> ${vuln.fixedVersion}</p>`
                    : ""
                }
                <p>${vuln.description}</p>
              </div>
            `
              )
              .join("")}
          </div>
        `
          )
          .join("")}
      </body>
      </html>
    `;
}

function generateHtmlWithoutTrees(
  analysisMap: Map<string, DependencyAnalysis>
): string {
  return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 20px;
                    color: var(--vscode-foreground);
                    background-color: var(--vscode-editor-background);
                }
                .search-container {
                    position: sticky;
                    top: 0;
                    background-color: var(--vscode-editor-background);
                    padding: 10px 0;
                    margin-bottom: 20px;
                }
                .search-input {
                    padding: 8px;
                    width: 100%;
                    max-width: 300px;
                    margin-right: 10px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 4px;
                }
                .dependency-item {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 8px;
                    margin: 4px 0;
                    background-color: var(--vscode-editor-background);
                    border: 1px solid var(--vscode-panel-border);
                    border-radius: 4px;
                }
                .hidden {
                    display: none;
                }
                h2 {
                    color: var(--vscode-textLink-foreground);
                    border-bottom: 1px solid var(--vscode-panel-border);
                    padding-bottom: 8px;
                }
                .section {
                    margin-bottom: 24px;
                }
            </style>
            <script>
                function searchDependencies() {
                    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
                    const items = document.getElementsByClassName('dependency-item');

                    for (const item of items) {
                        const depName = item.getAttribute('data-name').toLowerCase();
                        item.classList.toggle('hidden', !depName.includes(searchTerm));
                    }
                }
            </script>
        </head>
        <body>
            <h1>Dependency Analysis Report</h1>
            <div class="search-container">
                <input type="text"
                       id="searchInput"
                       class="search-input"
                       placeholder="Search dependencies..."
                       oninput="searchDependencies()">
            </div>
            ${Array.from(analysisMap.entries())
              .map(
                ([language, analysis]) => `
                <div class="section">
                    <h2>${language}</h2>

                    ${
                      analysis.missingExtensions.length > 0
                        ? `
                        <h3 style="color: var(--vscode-errorForeground);">Missing VS Code Extensions</h3>
                        <ul>${analysis.missingExtensions
                          .map((ext) => `<li>${ext}</li>`)
                          .join("")}</ul>
                    `
                        : ""
                    }

                    <h3>Declared Dependencies (${analysis.declared.size})</h3>
                    <div>${[...analysis.declared]
                      .map(
                        (dep) => `
                        <div class="dependency-item" data-name="${dep}">
                            <span>${dep}</span>
                        </div>
                    `
                      )
                      .join("")}</div>

                    <h3>Installed Dependencies (${analysis.installed.size})</h3>
                    <div>${[...analysis.installed]
                      .map(
                        (dep) => `
                        <div class="dependency-item" data-name="${dep}">
                            <span>${dep}</span>
                        </div>
                    `
                      )
                      .join("")}</div>

                    <h3 style="color: var(--vscode-errorForeground);">Missing Dependencies (${
                      analysis.missing.size
                    })</h3>
                    <ul>${[...analysis.missing]
                      .map((dep) => `<li>${dep}</li>`)
                      .join("")}</ul>

                    <h3 style="color: var(--vscode-warningForeground);">Extra Dependencies (${
                      analysis.extra.size
                    })</h3>
                    <div>${[...analysis.extra]
                      .map(
                        (dep) => `
                        <div class="dependency-item" data-name="${dep}">
                            <span>${dep}</span>
                        </div>
                    `
                      )
                      .join("")}</div>
                </div>
            `
              )
              .join("")}
        </body>
        </html>
    `;
}

export function activate(context: vscode.ExtensionContext) {
  console.log("Depramanger extension is now active!");

  const analyzer = new DependencyAnalyzer();

  let currentPanel: vscode.WebviewPanel | undefined = undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.scanDependencies",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Scanning for dependencies...",
            cancellable: false,
          },
          async () => {
            const analysisMap = await analyzer.analyzeDependencies(folderPath);
            const depTrees = new Map<string, Map<string, DependencyNode>>();
            for (const config of languageConfigs) {
              try {
                const analysis = await analyzer.analyzeLanguageDependencies(
                  folderPath,
                  config
                );
                if (analysis) {
                  analysisMap.set(config.name, analysis);

                  // Build dependency trees
                  const trees = await analyzer.analyzeDependencyTree(
                    folderPath,
                    config
                  );
                  depTrees.set(config.name, trees);
                }
              } catch (error) {
                console.error(
                  `Error analyzing ${config.name} dependencies:`,
                  error
                );
              }
            }

            if (analysisMap.size > 0) {
              if (currentPanel) {
                currentPanel.dispose();
              }

              currentPanel = vscode.window.createWebviewPanel(
                "dependencyReport",
                "Dependency Report",
                vscode.ViewColumn.One,
                { enableScripts: true }
              );

              currentPanel.webview.html = generateHtml(
                analysisMap,
                depTrees,
                analyzer
              );

              currentPanel.onDidDispose(() => {
                currentPanel = undefined;
              });
            } else {
              vscode.window.showInformationMessage(
                "No dependencies found in the workspace."
              );
            }
          }
        );
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.scanDependenciesWithoutDepedencyTree",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Scanning for dependencies...",
            cancellable: false,
          },
          async () => {
            const analysisMap = await analyzer.analyzeDependencies(folderPath);
            if (analysisMap.size > 0) {
              if (currentPanel) {
                currentPanel.dispose();
              }

              currentPanel = vscode.window.createWebviewPanel(
                "dependencyReport",
                "Dependency Report",
                vscode.ViewColumn.One,
                { enableScripts: true }
              );

              currentPanel.webview.html = generateHtmlWithoutTrees(analysisMap);

              currentPanel.onDidDispose(() => {
                currentPanel = undefined;
              });
            } else {
              vscode.window.showInformationMessage(
                "No dependencies found in the workspace."
              );
            }
          }
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.syncDeclarations",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Syncing dependency declarations...",
            cancellable: false,
          },
          async () => {
            await analyzer.syncMissingDeclarations(folderPath);
            vscode.window.showInformationMessage(
              "Dependency declarations synced successfully!"
            );
          }
        );
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.checkUpdates",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;
        const analyzer = new DependencyAnalyzer();

        await analyzer.promptForUpdates(folderPath);
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.installDependency",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;
        const analyzer = new DependencyAnalyzer();

        await analyzer.installSpecificDependency(folderPath);
      }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.uninstallDependency",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;
        const analyzer = new DependencyAnalyzer();

        await analyzer.uninstallSpecificDependency(folderPath);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.scanVulnerabilities",
      async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
          vscode.window.showErrorMessage("No workspace folder found!");
          return;
        }

        const folderPath = workspaceFolders[0].uri.fsPath;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Scanning for vulnerabilities...",
            cancellable: false,
          },
          async () => {
            const vulnerabilities = await analyzer.scanVulnerabilities(
              folderPath
            );

            if (vulnerabilities.size > 0) {
              const panel = vscode.window.createWebviewPanel(
                "vulnerabilityReport",
                "Vulnerability Report",
                vscode.ViewColumn.One,
                { enableScripts: true }
              );

              panel.webview.html = generateVulnerabilityHtml(vulnerabilities);
            } else {
              vscode.window.showInformationMessage(
                "No vulnerabilities found in dependencies."
              );
            }
          }
        );
      }
    )
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) return;

      const folderPath = workspaceFolders[0].uri.fsPath;
      const document = event.document;

      // Find the appropriate language config for this file
      for (const config of languageConfigs) {
        if (config.dependencyFiles.includes(path.basename(document.fileName))) {
          await updateDiagnostics(folderPath, config, document);
          break;
        }
      }
    }),

    vscode.workspace.onDidOpenTextDocument(async (document) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) return;

      const folderPath = workspaceFolders[0].uri.fsPath;

      // Find the appropriate language config for this file
      for (const config of languageConfigs) {
        if (config.dependencyFiles.includes(path.basename(document.fileName))) {
          await updateDiagnostics(folderPath, config, document);
          break;
        }
      }
    })
  );

  // Clear diagnostics when files are closed
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      versionDiagnostics.delete(document.uri);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "dependencyChecker.checkCurrentFileImports",
      async () => {
        const analyzer = new DependencyAnalyzer();
        const analysis = await analyzer.analyzeCurrentFileImports();

        if (!analysis) {
          return;
        }

        if (analysis.missingImports.length === 0) {
          vscode.window.showInformationMessage(
            `All ${analysis.detectedImports.size} imports are already installed.`
          );
          return;
        }
        await analyzer.installMissingImports();
      }
    )
  );
}

export function deactivate() {
  console.log("Depramanger extension is now deactivated.");
}
