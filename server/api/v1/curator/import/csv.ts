/**
 * A small RFC 4180 CSV reader for candidate sheets exported from a spreadsheet: quoted fields,
 * doubled quotes, commas and newlines inside quotes, CRLF or LF line ends, a UTF-8 BOM, and a
 * comma, semicolon or tab delimiter (detected from the header line). No dependency.
 */

export interface CsvTable {
  header: string[];
  /** Data rows; `line` is the 1-based line of the row's first character in the file. */
  rows: { line: number; cells: string[] }[];
}

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = "CsvError";
  }
}

function detectDelimiter(text: string): string {
  let inQuotes = false;
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ",";
}

/** Parses CSV text into rows of cells. Throws CsvError on an unterminated quote. */
export function parseCsv(input: string, maxRows = 10_000): CsvTable {
  const text = input.replace(/^\ufeff/, "");
  const delimiter = detectDelimiter(text);
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldQuoted = false;
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;

  const endField = () => {
    cells.push(fieldQuoted ? field : field.trim());
    field = "";
    fieldQuoted = false;
  };
  const endRecord = () => {
    endField();
    // Skip blank lines (a single empty cell).
    if (!(cells.length === 1 && cells[0] === "")) records.push({ line: recordLine, cells });
    if (records.length > maxRows + 1) throw new CsvError(`more than ${maxRows} rows`, line);
    cells = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      inQuotes = true;
      fieldQuoted = true;
      field = "";
      quoteLine = line;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new CsvError("unterminated quoted field", quoteLine);
  if (field !== "" || cells.length > 0) endRecord();

  const [head, ...rest] = records;
  if (!head) return { header: [], rows: [] };
  return { header: head.cells.map((h) => h.trim()), rows: rest };
}
