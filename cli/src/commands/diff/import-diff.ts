/**
 * Paperclip Import Package Diff Tool
 * 
 * Compares two import packages for overlap and drift.
 * 
 * Usage:
 *   paperclipai diff packages --left <path> --right <path>
 * 
 * Output:
 *   - Summary of overlap/drift/conflicts
 *   - Detailed JSON report
 * 
 * Example:
 *   paperclipai diff packages --left ./backup-v1 --right ./backup-v2
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { createHash } from "node:crypto";

// ============
// Data Types
// ============

type EntityKind = "company" | "agent" | "project" | "issue" | "skill";

interface PackageEntity {
  kind: EntityKind;
  id: string;
  slug: string;
  name?: string;
  path: string;
  hash: string;
}

interface DiffResult {
  overlap: Array<{
    kind: EntityKind;
    slug: string;
    leftPath: string;
    rightPath: string;
  }>;
  leftDrift: Array<{ kind: EntityKind; slug: string; path: string }>;
  rightDrift: Array<{ kind: EntityKind; slug: string; path: string }>;
  conflicts: Array<{
    kind: EntityKind;
    slug: string;
    leftHash: string;
    rightHash: string;
    leftPath: string;
    rightPath: string;
  }>;
}

// ============
// Helper Functions
// ============

async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function scanPackage(rootPath: string): Promise<PackageEntity[]> {
  async function scan(dir: string): Promise<PackageEntity[]> {
    const entities: PackageEntity[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        const nested = await scan(fullPath);
        entities.push(...nested);
      } else if (entry.isFile()) {
        const relativePath = normalizePath(path.relative(rootPath, fullPath));
        
        // Skip metadata files
        if (relativePath === ".paperclip.yaml" || relativePath === "README.md") {
          continue;
        }
        
        // Determine entity kind
        let kind: EntityKind | null = null;
        
        if (["COMPANY.md", "TEAM.md", "AGENTS.md"].includes(entry.name)) {
          kind = "company";
        } else if (relativePath.startsWith("agents/") && entry.name.endsWith(".md")) {
          kind = "agent";
        } else if (relativePath.startsWith("projects/") && entry.name.endsWith(".md")) {
          kind = "project";
        } else if (relativePath.startsWith("tasks/") && entry.name.endsWith(".md")) {
          kind = "issue";
        } else if (relativePath.startsWith("skills/") && entry.name.endsWith(".md")) {
          kind = "skill";
        }
        
        if (kind) {
          const slug = entry.name.replace(".md", "");
          const hash = await hashFile(fullPath);
          
          const entity: PackageEntity = { kind, id: slug, slug, path: relativePath, hash };
          
          // Try to extract name from frontmatter
          try {
            const content = await readFile(fullPath, "utf8");
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            if (nameMatch) {
              entity.name = nameMatch[1].trim();
            }
          } catch {
            // Ignore parsing errors
          }
          
          entities.push(entity);
        }
      }
    }
    
    return entities;
  }

  return scan(rootPath);
}

function compare(left: PackageEntity[], right: PackageEntity[]): DiffResult {
  const leftMap = new Map(left.map(e => [`${e.kind}:${e.slug}`, e]));
  const rightMap = new Map(right.map(e => [`${e.kind}:${e.slug}`, e]));
  
  const overlap: DiffResult["overlap"] = [];
  const leftDrift: DiffResult["leftDrift"] = [];
  const rightDrift: DiffResult["rightDrift"] = [];
  const conflicts: DiffResult["conflicts"] = [];
  
  // Check left entities
  for (const [key, leftEntity] of leftMap) {
    const rightEntity = rightMap.get(key);
    
    if (rightEntity) {
      overlap.push({ kind: leftEntity.kind, slug: leftEntity.slug, leftPath: leftEntity.path, rightPath: rightEntity.path });
      if (leftEntity.hash !== rightEntity.hash) {
        conflicts.push({
          kind: leftEntity.kind,
          slug: leftEntity.slug,
          leftHash: leftEntity.hash,
          rightHash: rightEntity.hash,
          leftPath: leftEntity.path,
          rightPath: rightEntity.path,
        });
      }
    } else {
      leftDrift.push({ kind: leftEntity.kind, slug: leftEntity.slug, path: leftEntity.path });
    }
  }
  
  // Check right-only entities
  for (const [key, rightEntity] of rightMap) {
    if (!leftMap.has(key)) {
      rightDrift.push({ kind: rightEntity.kind, slug: rightEntity.slug, path: rightEntity.path });
    }
  }
  
  return { overlap, leftDrift, rightDrift, conflicts };
}

function formatSummary(result: DiffResult) {
  const lines: string[] = [];
  
  lines.push(pc.bold("\n=== OVERLAP (in both packages) ==="));
  if (result.overlap.length === 0) {
    lines.push(pc.gray("  No overlapping entities"));
  } else {
    for (const item of result.overlap) {
      lines.push(`  ${item.kind}: ${item.slug} (left: ${item.leftPath}, right: ${item.rightPath})`);
    }
  }
  
  lines.push(pc.bold("\n=== CONFLICTS (same slug, different content) ==="));
  if (result.conflicts.length === 0) {
    lines.push(pc.green("  No conflicts found"));
  } else {
    for (const item of result.conflicts) {
      lines.push(pc.red(`  ${item.kind}: ${item.slug}`));
      lines.push(`    Left:  ${item.leftPath} [${item.leftHash}]`);
      lines.push(`    Right: ${item.rightPath} [${item.rightHash}]`);
    }
  }
  
  lines.push(pc.bold("\n=== DRIFT (only in left package) ==="));
  if (result.leftDrift.length === 0) {
    lines.push(pc.gray("  No left-only entities"));
  } else {
    for (const item of result.leftDrift) {
      lines.push(`  ${item.kind}: ${item.slug} (${item.path})`);
    }
  }
  
  lines.push(pc.bold("\n=== DRIFT (only in right package) ==="));
  if (result.rightDrift.length === 0) {
    lines.push(pc.gray("  No right-only entities"));
  } else {
    for (const item of result.rightDrift) {
      lines.push(`  ${item.kind}: ${item.slug} (${item.path})`);
    }
  }
  
  return lines.join("\n");
}

// ============
// CLI
// ============

async function main() {
  const args = process.argv.slice(2);
  let leftPath: string;
  let rightPath: string;
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
${pc.bold("Paperclip Import Package Diff Tool")}

Compares two import packages for overlap and drift.

Usage:
  node import-diff.js --left <path> --right <path>

Options:
  --left <path>     Path to left package directory (REQUIRED)
  --right <path>    Path to right package directory (REQUIRED)
  --help, -h        Show this help message

Example:
  node import-diff.js --left ./backup-v1 --right ./backup-v2

Output:
  - Summary of overlap, conflicts, and drift
  - Detailed JSON report to stdout
`);
    process.exit(0);
  }
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--left" && args[i + 1]) {
      leftPath = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--right" && args[i + 1]) {
      rightPath = path.resolve(args[i + 1]);
      i++;
    }
  }
  
  if (!leftPath || !rightPath) {
    console.error(pc.red("Error: Both --left and --right paths are required."));
    console.error("Usage: node import-diff.js --left <path> --right <path>");
    process.exit(1);
  }
  
  // Validate paths
  try {
    const leftStat = await stat(leftPath);
    const rightStat = await stat(rightPath);
    
    if (!leftStat.isDirectory()) {
      console.error(pc.red(`Error: --left path is not a directory: ${leftPath}`));
      process.exit(1);
    }
    if (!rightStat.isDirectory()) {
      console.error(pc.red(`Error: --right path is not a directory: ${rightPath}`));
      process.exit(1);
    }
  } catch (err) {
    console.error(pc.red(`Error: Could not access paths: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
  
  console.log(pc.blue("Scanning left package...  ") + leftPath);
  const leftEntities = await scanPackage(leftPath);
  console.log(pc.blue("Scanning right package... ") + rightPath);
  const rightEntities = await scanPackage(rightPath);
  
  console.log(pc.blue("\nComparing packages...\n"));
  const result = compare(leftEntities, rightEntities);
  
  // Output summary
  console.log(formatSummary(result));
  
  // Output JSON for programmatic use
  console.log(pc.gray("\n\n=== JSON REPORT ==="));
  console.log(JSON.stringify({
    left: leftPath,
    right: rightPath,
    timestamp: new Date().toISOString(),
    leftCount: leftEntities.length,
    rightCount: rightEntities.length,
    summary: {
      overlap: result.overlap.length,
      leftDrift: result.leftDrift.length,
      rightDrift: result.rightDrift.length,
      conflicts: result.conflicts.length,
    },
    details: result,
  }, null, 2));
}

export async function diffImportPackages(
  opts: { left: string; right: string }
): Promise<void> {
  await runDiff(opts.left, opts.right);
}

async function runDiff(leftPath: string, rightPath: string): Promise<void> {
  const args = process.argv.slice(2);
  let leftPathFromArgs: string | undefined;
  let rightPathFromArgs: string | undefined;
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
${pc.bold("Paperclip Import Package Diff Tool")}

Compares two import packages for overlap and drift.

Usage:
  paperclipai diff packages --left <path> --right <path>

Options:
  --left <path>     Path to left package directory (REQUIRED)
  --right <path>    Path to right package directory (REQUIRED)
  --help, -h        Show this help message

Example:
  paperclipai diff packages --left ./backup-v1 --right ./backup-v2

Output:
  - Summary of overlap, conflicts, and drift
  - Detailed JSON report
`);
    process.exit(0);
  }
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--left" && args[i + 1]) {
      leftPathFromArgs = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--right" && args[i + 1]) {
      rightPathFromArgs = path.resolve(args[i + 1]);
      i++;
    }
  }
  
  if (!leftPathFromArgs || !rightPathFromArgs) {
    console.error(pc.red("Error: Both --left and --right paths are required."));
    console.error("Usage: paperclipai diff packages --left <path> --right <path>");
    process.exit(1);
  }
  
  leftPath = leftPathFromArgs;
  rightPath = rightPathFromArgs;
  
  // Validate paths
  try {
    const leftStat = await stat(leftPath);
    const rightStat = await stat(rightPath);
    
    if (!leftStat.isDirectory()) {
      console.error(pc.red(`Error: --left path is not a directory: ${leftPath}`));
      process.exit(1);
    }
    if (!rightStat.isDirectory()) {
      console.error(pc.red(`Error: --right path is not a directory: ${rightPath}`));
      process.exit(1);
    }
  } catch (err) {
    console.error(pc.red(`Error: Could not access paths: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
  
  console.log(pc.blue("Scanning left package...  ") + leftPath);
  const leftEntities = await scanPackage(leftPath);
  console.log(pc.blue("Scanning right package... ") + rightPath);
  const rightEntities = await scanPackage(rightPath);
  
  console.log(pc.blue("\nComparing packages...\n"));
  const result = compare(leftEntities, rightEntities);
  
  // Output summary
  console.log(formatSummary(result));
  
  // Output JSON for programmatic use
  console.log(pc.gray("\n\n=== JSON REPORT ==="));
  console.log(JSON.stringify({
    left: leftPath,
    right: rightPath,
    timestamp: new Date().toISOString(),
    leftCount: leftEntities.length,
    rightCount: rightEntities.length,
    summary: {
      overlap: result.overlap.length,
      leftDrift: result.leftDrift.length,
      rightDrift: result.rightDrift.length,
      conflicts: result.conflicts.length,
    },
    details: result,
  }, null, 2));
}

// Entry point for direct script execution
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      await runDiff("left", "right");
    } catch (err) {
      console.error(pc.red(`Fatal error: ${err instanceof Error ? err.message : String(err)}`));
      process.exit(1);
    }
  })();
}
