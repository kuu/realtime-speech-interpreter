// Minimal RFC 4180 CSV reader/writer (no dependencies). Used by terms.csv handling.

/** Parse CSV text. Returns [{ line, cells: string[] }]. A leading UTF-8 BOM is ignored. Throws on bad quoting. */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let rowLine = 1;
  const endField = () => {
    row.push(field);
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== "" || wasQuoted) throw new Error(`line ${line}: quote inside an unquoted field`);
      quoted = true;
      wasQuoted = true;
    } else if (c === ",") {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endField();
      rows.push({ line: rowLine, cells: row });
      row = [];
      line++;
      rowLine = line;
    } else {
      if (wasQuoted) throw new Error(`line ${line}: text after closing quote`);
      field += c;
    }
  }
  if (quoted) throw new Error(`line ${rowLine}: unterminated quoted field`);
  if (field !== "" || row.length || wasQuoted) {
    endField();
    rows.push({ line: rowLine, cells: row });
  }
  return rows;
}

/** Quote a field only when it needs it. */
export function csvField(v) {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize rows (arrays of strings) with LF line endings and a trailing newline. */
export function serializeCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
