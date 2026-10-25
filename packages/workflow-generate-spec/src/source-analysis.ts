import { z } from 'zod';

/**
 * Facts read from source text with regular expressions. Cheap, deterministic and offline,
 * and incomplete by nature: they give the agent and the reviewer something verifiable to
 * check the spec against. They are not the spec.
 */
export const fileFactsSchema = z.object({
  path: z.string(),
  lines: z.number().int(),
  exports: z.array(z.string()),
  imports: z.array(z.string()),
  components: z.array(z.string()),
  apiCalls: z.array(z.string()),
  validations: z.array(z.string()),
});

export const sourceAnalysisSchema = z.object({
  fileCount: z.number().int(),
  totalLines: z.number().int(),
  /** Extension → number of files. */
  languages: z.record(z.string(), z.number().int()),
  files: z.array(fileFactsSchema),
});

export type FileFacts = z.infer<typeof fileFactsSchema>;
export type SourceAnalysis = z.infer<typeof sourceAnalysisSchema>;

const MAX_ITEMS = 20;
const MAX_ITEM_LENGTH = 120;

function collect(
  text: string,
  pattern: RegExp,
  pick: (match: RegExpMatchArray) => string | undefined,
) {
  const found = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = pick(match)?.trim();
    if (value === undefined || value === '') continue;
    found.add(value.length > MAX_ITEM_LENGTH ? `${value.slice(0, MAX_ITEM_LENGTH)}…` : value);
    if (found.size >= MAX_ITEMS) break;
  }
  return [...found];
}

const EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
const DEFAULT_EXPORT_PATTERN = /export\s+default\s+(?!function|class|async)([A-Za-z0-9_$]+)/g;
const IMPORT_PATTERN =
  /import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
const COMPONENT_PATTERN = /<([A-Z][A-Za-z0-9]*(?:\.[A-Z][A-Za-z0-9]*)*)[\s/>]/g;
const API_PATTERN =
  /\b(fetch|axios(?:\.(?:get|post|put|patch|delete|request))?|http\.(?:get|post|put|patch|delete)|\$http\.(?:get|post|put|patch|delete))\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")?/g;
const VALIDATION_PATTERN =
  /\b(required|minLength|maxLength|pattern|min|max|z\.[a-zA-Z]+|yup\.[a-zA-Z]+|Validators\.[a-zA-Z]+|validate[A-Za-z]*)\b(?:\s*[:=(]\s*([^,;)\n}]{1,60}))?/g;

export function analyzeFile(path: string, content: string): FileFacts {
  return {
    path,
    lines: content === '' ? 0 : content.split(/\r?\n/).length,
    exports: [
      ...collect(content, EXPORT_PATTERN, (m) => m[1]),
      ...collect(content, DEFAULT_EXPORT_PATTERN, (m) =>
        m[1] === undefined ? undefined : `default ${m[1]}`,
      ),
    ].slice(0, MAX_ITEMS),
    imports: collect(content, IMPORT_PATTERN, (m) => m[1] ?? m[2]),
    components: collect(content, COMPONENT_PATTERN, (m) => m[1]),
    apiCalls: collect(content, API_PATTERN, (m) =>
      m[1] === undefined ? undefined : `${m[1]}${m[2] === undefined ? '' : ` ${m[2]}`}`,
    ),
    validations: collect(content, VALIDATION_PATTERN, (m) =>
      m[1] === undefined ? undefined : `${m[1]}${m[2] === undefined ? '' : ` ${m[2].trim()}`}`,
    ),
  };
}

export function summarize(files: readonly FileFacts[]): SourceAnalysis {
  const languages: Record<string, number> = {};
  for (const file of files) {
    const ext = /\.[^./]+$/.exec(file.path)?.[0].toLowerCase() ?? '(none)';
    languages[ext] = (languages[ext] ?? 0) + 1;
  }
  return {
    fileCount: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    languages,
    files: [...files],
  };
}
