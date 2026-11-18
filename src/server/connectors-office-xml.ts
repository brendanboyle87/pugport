import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import AdmZip from 'adm-zip';
import { DOMParser, XMLSerializer, type Document, type Element } from '@xmldom/xmldom';

const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const PRESENTATION = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
export const officePackageLimit = 12 * 1024 * 1024;
const expandedLimit = 32 * 1024 * 1024;
const xmlLimit = 4 * 1024 * 1024;
const serializer = new XMLSerializer();
function validText(value: string) {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/u.test(value))
    throw new Error('Office text contains characters that are invalid in XML.');
  return value;
}
const escape = (value: string) =>
  validText(value).replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[s]!,
  );
const elements = (node: Element | Document, ns: string, name: string) =>
  Array.from(node.getElementsByTagNameNS(ns, name));

function parse(xml: string): Document {
  if (Buffer.byteLength(xml) > xmlLimit || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml))
    throw new Error('Office XML contains a DTD/entity or exceeds the size limit.');
  const document = new DOMParser({
    onError: () => {
      throw new Error('Malformed Office XML.');
    },
  }).parseFromString(xml, 'application/xml');
  if (!document.documentElement) throw new Error('Office XML has no document element.');
  const pending = [{ node: document.documentElement, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > 100_000 || depth > 256) throw new Error('Office XML is too complex.');
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) pending.push({ node: child as Element, depth: depth + 1 });
    }
  }
  return document;
}

function archive(input: Uint8Array): AdmZip {
  if (input.byteLength > officePackageLimit) throw new Error('Office file exceeds the 12 MiB editing limit.');
  const zip = new AdmZip(Buffer.from(input));
  const entries = zip.getEntries();
  if (entries.length > 2_000) throw new Error('Office file has too many ZIP entries.');
  let expanded = 0;
  const names = new Set<string>();
  for (const entry of entries) {
    const name = entry.entryName;
    if (
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((p) => p === '..' || p === '.') ||
      /[\x00-\x1f]/.test(name) ||
      names.has(name.toLowerCase())
    )
      throw new Error('Office ZIP has an unsafe or duplicate entry name.');
    names.add(name.toLowerCase());
    if (/^_xmlsignatures\/|vbaproject\.bin$|encryptedpackage$/i.test(name))
      throw new Error('Signed, encrypted or macro-enabled Office files are not supported.');
    const { size, compressedSize, flags, method } = entry.header;
    expanded += size;
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 16 * 1024 * 1024 ||
      expanded > expandedLimit ||
      size > Math.max(1_024_000, compressedSize * 250) ||
      flags & 1 ||
      ![0, 8].includes(method)
    )
      throw new Error('Office ZIP exceeds decompression limits or uses unsupported encryption/compression.');
    if (/\.(?:xml|rels)$/i.test(name)) {
      if (size > xmlLimit) throw new Error('Office XML part exceeds the size limit.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(entry.getData());
      if (source.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)/i.test(source))
        throw new Error('Office XML must be UTF-8 and cannot contain DTDs or entities.');
    }
  }
  return zip;
}
function xml(zip: AdmZip, path: string) {
  const entry = zip.getEntry(path);
  if (!entry) throw new Error(`Missing Office part: ${path}`);
  return parse(entry.getData().toString('utf8'));
}
function validateKind(zip: AdmZip, kind: 'word' | 'presentation') {
  const main = kind === 'word' ? 'word/document.xml' : 'ppt/presentation.xml';
  const type = kind === 'word' ? 'wordprocessingml.document.main' : 'presentationml.presentation.main';
  const content = xml(zip, '[Content_Types].xml');
  const record = elements(content, CONTENT, 'Override').find((n) => n.getAttribute('PartName') === `/${main}`);
  const rels = xml(zip, '_rels/.rels');
  const rel = elements(rels, PACKAGE_REL, 'Relationship').find(
    (n) => n.getAttribute('Type') === `${REL}/officeDocument`,
  );
  if (
    record?.getAttribute('ContentType') !== `application/vnd.openxmlformats-officedocument.${type}+xml` ||
    !rel ||
    ![main, `/${main}`].includes(rel.getAttribute('Target') || '') ||
    rel.getAttribute('TargetMode') === 'External'
  )
    throw new Error('The Office package type or main-document relationship is unsupported.');
}
function wordDocument(zip: AdmZip) {
  validateKind(zip, 'word');
  return xml(zip, 'word/document.xml');
}
function save(zip: AdmZip, path: string, document: Document) {
  const serialized = serializer.serializeToString(document);
  if (Buffer.byteLength(serialized) > xmlLimit) throw new Error('Updated Office XML exceeds the size limit.');
  zip.addFile(path, Buffer.from(serialized));
}
function finish(zip: AdmZip) {
  const result = zip.toBuffer();
  archive(result);
  return result;
}
function relationship(id: string, type: string, target: string) {
  return `<Relationship Id="${escape(id)}" Type="${REL}/${type}" Target="${escape(target)}"/>`;
}
function relationships(value: string) {
  return `<Relationships xmlns="${PACKAGE_REL}">${value}</Relationships>`;
}
function baseZip(main: string, overrides: string): AdmZip {
  const zip = new AdmZip();
  zip.addFile('_rels/.rels', Buffer.from(relationships(relationship('rId1', 'officeDocument', main))));
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      `<Types xmlns="${CONTENT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`,
    ),
  );
  return zip;
}
function override(path: string, type: string) {
  return `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
}
function wordParagraph(document: Document, content: string): Element {
  const paragraph = document.createElementNS(WORD, 'w:p');
  const run = document.createElementNS(WORD, 'w:r');
  const lines = validText(content).split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (i) run.appendChild(document.createElementNS(WORD, 'w:br'));
    const text = document.createElementNS(WORD, 'w:t');
    text.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
    text.appendChild(document.createTextNode(lines[i]));
    run.appendChild(text);
  }
  paragraph.appendChild(run);
  return paragraph;
}
function wordBody(document: Document) {
  const body = elements(document, WORD, 'body')[0];
  if (!body) throw new Error('Only standard .docx Word documents are supported.');
  return body;
}
function paragraphText(paragraph: Element) {
  // Text in drawings, deleted revisions and fields is deliberately not evaluated.
  return elements(paragraph, WORD, '*')
    .filter((n) => ['t', 'br', 'tab'].includes(n.localName!))
    .map((n) => (n.localName === 'br' ? '\n' : n.localName === 'tab' ? '\t' : n.textContent || ''))
    .join('');
}
export function createWord(paragraphs: string[]): Buffer {
  const zip = baseZip('word/document.xml', override('word/document.xml', 'wordprocessingml.document.main'));
  const document = parse(
    `<w:document xmlns:w="${WORD}"><w:body><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  const body = wordBody(document);
  for (const content of paragraphs) body.insertBefore(wordParagraph(document, content), body.lastChild);
  save(zip, 'word/document.xml', document);
  return finish(zip);
}
export function readWord(input: Uint8Array) {
  const zip = archive(input),
    document = wordDocument(zip);
  const all = elements(wordBody(document), WORD, 'p');
  let used = 0;
  const paragraphs: { index: number; text: string }[] = [];
  for (let index = 0; index < all.length; index++) {
    const value = paragraphText(all[index]);
    if (paragraphs.length >= 10_000 || used + value.length > 500_000) break;
    used += value.length;
    paragraphs.push({ index, text: value });
  }
  return {
    paragraphs,
    totalParagraphs: all.length,
    truncated: paragraphs.length < all.length,
    scope:
      'Body and table text only. Headers, footers, images, charts, field results and tracked deletions are not rendered.',
  };
}
export function appendWord(input: Uint8Array, paragraphs: string[]) {
  const zip = archive(input),
    document = wordDocument(zip),
    body = wordBody(document);
  const section =
    Array.from(body.childNodes).find(
      (n) => n.nodeType === 1 && (n as Element).namespaceURI === WORD && (n as Element).localName === 'sectPr',
    ) || null;
  for (const value of paragraphs) body.insertBefore(wordParagraph(document, value), section);
  save(zip, 'word/document.xml', document);
  return finish(zip);
}
export function replaceWordParagraph(input: Uint8Array, index: number, expectedText: string, replacement: string) {
  const zip = archive(input),
    document = wordDocument(zip),
    body = wordBody(document);
  const paragraph = elements(body, WORD, 'p')[index];
  if (!paragraph || paragraph.parentNode !== body || paragraphText(paragraph) !== expectedText)
    throw new Error(
      'The paragraph no longer matches the expected text, or is inside a table. Read the document again.',
    );
  const children = Array.from(paragraph.childNodes).filter((n) => n.nodeType === 1) as Element[];
  if (children.some((n) => n.namespaceURI !== WORD || !['pPr', 'r'].includes(n.localName!)))
    throw new Error(
      'This paragraph has hyperlinks, bookmarks, tracked changes or other complex content. Only plain paragraphs can be replaced.',
    );
  const runs = children.filter((n) => n.localName === 'r');
  const styles = runs.map((r) => elements(r, WORD, 'rPr')[0]).map((n) => (n ? serializer.serializeToString(n) : ''));
  if (
    new Set(styles).size > 1 ||
    runs.some((r) =>
      Array.from(r.childNodes).some(
        (n) =>
          n.nodeType === 1 &&
          ((n as Element).namespaceURI !== WORD || !['rPr', 't', 'br', 'tab'].includes((n as Element).localName!)),
      ),
    )
  )
    throw new Error('Mixed formatting, fields or drawings cannot be replaced by the plain-text editor.');
  const fresh = wordParagraph(document, replacement);
  const run = elements(fresh, WORD, 'r')[0];
  const style = runs[0] && elements(runs[0], WORD, 'rPr')[0];
  if (style) run.insertBefore(style.cloneNode(true), run.firstChild);
  for (const old of runs) paragraph.removeChild(old);
  paragraph.appendChild(run);
  save(zip, 'word/document.xml', document);
  return finish(zip);
}

export interface PlainSlide {
  title: string;
  paragraphs: string[];
}
const group =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const pNamespaces = `xmlns:p="${PRESENTATION}" xmlns:a="${DRAWING}" xmlns:r="${REL}"`;
const colorMap =
  '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
function slideXml(slide: PlainSlide, width = 12_192_000, height = 6_858_000) {
  const x = Math.round(width * 0.05),
    w = Math.round(width * 0.9);
  const shape = (id: number, y: number, h: number, lines: string[], size: number) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${lines.map((line) => `<a:p><a:r><a:rPr lang="en-US" sz="${size}"/><a:t>${escape(line)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`).join('')}</p:txBody></p:sp>`;
  return `<p:sld ${pNamespaces} showMasterSp="0"><p:cSld><p:spTree>${group}${shape(2, Math.round(height * 0.07), Math.round(height * 0.17), [slide.title], 3200)}${shape(3, Math.round(height * 0.29), Math.round(height * 0.63), slide.paragraphs.length ? slide.paragraphs : [''], 2000)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}
function themeXml() {
  const colors = {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '1F2937',
    lt2: 'F3F4F6',
    accent1: '2563EB',
    accent2: '059669',
    accent3: 'D97706',
    accent4: '7C3AED',
    accent5: 'DB2777',
    accent6: '0891B2',
    hlink: '0000FF',
    folHlink: '800080',
  };
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `<a:theme xmlns:a="${DRAWING}" name="PugPort"><a:themeElements><a:clrScheme name="PugPort">${Object.entries(
    colors,
  )
    .map(([key, value]) => `<a:${key}><a:srgbClr val="${value}"/></a:${key}>`)
    .join(
      '',
    )}</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="PugPort"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}">${fill}<a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
export function createPresentation(slides: PlainSlide[]) {
  const parts: Record<string, string> = {
    'ppt/presentation.xml': `<p:presentation ${pNamespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': relationships(
      relationship('rIdMaster', 'slideMaster', 'slideMasters/slideMaster1.xml') +
        slides.map((_, i) => relationship(`rIdSlide${i + 1}`, 'slide', `slides/slide${i + 1}.xml`)).join(''),
    ),
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${pNamespaces}><p:cSld><p:spTree>${group}</p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships(
      relationship('rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml') +
        relationship('rIdTheme', 'theme', '../theme/theme1.xml'),
    ),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${pNamespaces} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships(
      relationship('rIdMaster', 'slideMaster', '../slideMasters/slideMaster1.xml'),
    ),
    'ppt/theme/theme1.xml': themeXml(),
  };
  let overrides =
    override('ppt/presentation.xml', 'presentationml.presentation.main') +
    override('ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster') +
    override('ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout') +
    override('ppt/theme/theme1.xml', 'theme');
  for (let i = 0; i < slides.length; i++) {
    const name = `ppt/slides/slide${i + 1}.xml`;
    parts[name] = slideXml(slides[i]);
    parts[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = relationships(
      relationship('rIdLayout', 'slideLayout', '../slideLayouts/slideLayout1.xml'),
    );
    overrides += override(name, 'presentationml.slide');
  }
  const zip = baseZip('ppt/presentation.xml', overrides);
  for (const [path, content] of Object.entries(parts)) zip.addFile(path, Buffer.from(content));
  return finish(zip);
}
function presentationParts(zip: AdmZip) {
  validateKind(zip, 'presentation');
  const document = xml(zip, 'ppt/presentation.xml');
  if (document.documentElement?.namespaceURI !== PRESENTATION)
    throw new Error('Only standard .pptx presentations are supported.');
  const rels = xml(zip, 'ppt/_rels/presentation.xml.rels');
  const lookup = new Map(elements(rels, PACKAGE_REL, 'Relationship').map((r) => [r.getAttribute('Id'), r]));
  const slides = elements(document, PRESENTATION, 'sldId').map((s) => {
    const rel = lookup.get(s.getAttributeNS(REL, 'id'));
    if (!rel || rel.getAttribute('Type') !== `${REL}/slide` || rel.getAttribute('TargetMode') === 'External')
      throw new Error('Invalid presentation slide relationship.');
    const target = rel.getAttribute('Target') || '';
    const path = target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('ppt', target));
    if (!path.startsWith('ppt/slides/') || !path.endsWith('.xml') || !zip.getEntry(path))
      throw new Error('Unsupported presentation slide path.');
    return path;
  });
  return { document, rels, slides };
}
export function readPresentation(input: Uint8Array) {
  const zip = archive(input),
    parts = presentationParts(zip);
  let used = 0;
  const slides: { index: number; text: string }[] = [];
  for (let index = 0; index < parts.slides.length; index++) {
    const document = xml(zip, parts.slides[index]);
    const text = elements(document, DRAWING, 'p')
      .map((p) =>
        elements(p, DRAWING, 't')
          .map((t) => t.textContent || '')
          .join(''),
      )
      .join('\n');
    if (used + text.length > 500_000 || slides.length >= 200) break;
    used += text.length;
    slides.push({ index, text });
  }
  return {
    slides,
    totalSlides: parts.slides.length,
    truncated: slides.length < parts.slides.length,
    scope: 'Slide text only. Images, charts, speaker notes, animations and layout are not rendered.',
  };
}
export function appendPresentationSlide(input: Uint8Array, slide: PlainSlide) {
  const zip = archive(input),
    { document, rels, slides } = presentationParts(zip);
  if (slides.length >= 200) throw new Error('The presentation already has 200 slides.');
  const layout = zip.getEntries().find((e) => /^ppt\/slideLayouts\/[^/]+\.xml$/.test(e.entryName))?.entryName;
  if (!layout) throw new Error('No standard slide layout is available in this presentation.');
  const suffix = randomUUID().replace(/-/g, ''),
    path = `ppt/slides/pugport-${suffix}.xml`,
    rid = `rIdPugPort${suffix}`;
  const size = elements(document, PRESENTATION, 'sldSz')[0];
  const width = Number(size?.getAttribute('cx')),
    height = Number(size?.getAttribute('cy'));
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    width > 100_000_000 ||
    height > 100_000_000
  )
    throw new Error('Unsupported presentation slide dimensions.');
  zip.addFile(path, Buffer.from(slideXml(slide, width, height)));
  zip.addFile(
    `ppt/slides/_rels/pugport-${suffix}.xml.rels`,
    Buffer.from(relationships(relationship('rIdLayout', 'slideLayout', posix.relative('ppt/slides', layout)))),
  );
  let list = elements(document, PRESENTATION, 'sldIdLst')[0];
  if (!list) {
    list = document.createElementNS(PRESENTATION, 'p:sldIdLst');
    document.documentElement!.insertBefore(list, size || null);
  }
  const ids = elements(document, PRESENTATION, 'sldId').map((n) => Number(n.getAttribute('id')));
  const number = Math.max(255, ...ids) + 1;
  if (!Number.isSafeInteger(number) || number >= 2_147_483_648) throw new Error('No valid slide ID is available.');
  const entry = document.createElementNS(PRESENTATION, 'p:sldId');
  entry.setAttribute('id', String(number));
  entry.setAttributeNS(REL, 'r:id', rid);
  list.appendChild(entry);
  const rel = rels.createElementNS(PACKAGE_REL, 'Relationship');
  rel.setAttribute('Id', rid);
  rel.setAttribute('Type', `${REL}/slide`);
  rel.setAttribute('Target', path.slice(4));
  rels.documentElement!.appendChild(rel);
  const content = xml(zip, '[Content_Types].xml'),
    type = content.createElementNS(CONTENT, 'Override');
  type.setAttribute('PartName', `/${path}`);
  type.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
  content.documentElement!.appendChild(type);
  save(zip, 'ppt/presentation.xml', document);
  save(zip, 'ppt/_rels/presentation.xml.rels', rels);
  save(zip, '[Content_Types].xml', content);
  return finish(zip);
}
export function replacePresentationText(
  input: Uint8Array,
  slideIndex: number,
  expectedText: string,
  replacement: string,
) {
  const zip = archive(input),
    { slides } = presentationParts(zip),
    path = slides[slideIndex];
  if (!path) throw new Error('Slide index is out of range.');
  const document = xml(zip, path),
    matches = elements(document, DRAWING, 't').filter((n) => n.textContent === expectedText);
  if (matches.length !== 1)
    throw new Error(
      'Text must exactly match one text run on this slide. Mixed-format or repeated text requires editing in PowerPoint.',
    );
  matches[0].textContent = validText(replacement);
  save(zip, path, document);
  return finish(zip);
}
export function createWorkbook(sheetName: string) {
  const zip = baseZip(
    'xl/workbook.xml',
    override('xl/workbook.xml', 'spreadsheetml.sheet.main') +
      override('xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet'),
  );
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
  );
  zip.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(relationships(relationship('rId1', 'worksheet', 'worksheets/sheet1.xml'))),
  );
  zip.addFile(
    'xl/worksheets/sheet1.xml',
    Buffer.from(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    ),
  );
  return finish(zip);
}
