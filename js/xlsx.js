// 最小のExcelファイル（.xlsx）生成。外部ライブラリを入れられないので、
// zip（無圧縮）とワークシートのXMLを自前で書く。
//
// CSVをやめた理由（2026-09-26）: Excelは開くときに中身を推測するため、
// 電話番号の先頭0が消える／列が分かれず全部A列に入る、が店のPCで実際に起きた。
// .xlsx なら「この欄は文字」「この欄は数」を明示できるので推測の余地がない。
//
// 使い方: xlsx.build({ sheetName, rows, widths }) → Uint8Array
//   rows   … 配列の配列。1行目が見出し。セルは 文字列／数値／null
//   widths … 列幅（文字数）。省略可
const xlsx = (() => {
  const enc = new TextEncoder();

  /* ---- zip（無圧縮・UTF-8ファイル名） ---- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const DOS_DATE = ((2026 - 1980) << 9) | (9 << 4) | 26;   // 中身に日付は不要だが有効な値を入れておく

  function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const u16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
    const u32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const head = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(DOS_DATE), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0),
      ]);
      parts.push(head, name, data);
      central.push(new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
        ...u16(0), ...u16(DOS_DATE), ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ]), name);
      offset += head.length + name.length + data.length;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }
    parts.push(new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(cdSize), ...u32(cdStart), ...u16(0),
    ]));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  /* ---- ワークシート ---- */
  // XMLに入れられない制御文字は落とす（改行・タブは残す）
  const escXml = (s) => String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function colName(i) {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }
  // 見出し行=太字(s=1)、それ以外=折り返し・上寄せ(s=2)。styles.xml の cellXfs の並びと対応
  function cell(ref, v, style) {
    if (v === null || v === undefined || v === "") return "";
    if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
  }
  function sheetXml(rows, widths) {
    const cols = widths && widths.length
      ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
      : "";
    const body = rows.map((r, ri) =>
      `<row r="${ri + 1}">${r.map((v, ci) => cell(colName(ci) + (ri + 1), v, ri === 0 ? 1 : 2)).join("")}</row>`
    ).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
${cols}<sheetData>${body}</sheetData></worksheet>`;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="游ゴシック"/></font><font><b/><sz val="11"/><name val="游ゴシック"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const workbookXml = (sheetName) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

  function build({ sheetName = "Sheet1", rows, widths }) {
    const files = [
      ["[Content_Types].xml", CONTENT_TYPES],
      ["_rels/.rels", ROOT_RELS],
      ["xl/workbook.xml", workbookXml(sheetName)],
      ["xl/_rels/workbook.xml.rels", WORKBOOK_RELS],
      ["xl/styles.xml", STYLES],
      ["xl/worksheets/sheet1.xml", sheetXml(rows, widths)],
    ].map(([name, text]) => ({ name, data: enc.encode(text) }));
    return zip(files);
  }

  return { build, MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
})();
