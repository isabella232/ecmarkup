import type { MarkupData } from 'parse5';
import type { EcmarkupError, Options } from './ecmarkup';
import type { Context } from './Context';
import type { BiblioData, StepBiblioEntry } from './Biblio';
import type { BuilderInterface } from './Builder';

import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as utils from './utils';
import * as hljs from 'highlight.js';
// Builders
import Import, { EmuImportElement } from './Import';
import H1 from './H1';
import Clause from './Clause';
import ClauseNumbers from './clauseNums';
import Algorithm from './Algorithm';
import Dfn from './Dfn';
import Example from './Example';
import Figure from './Figure';
import Note from './Note';
import Toc from './Toc';
import Menu from './Menu';
import Production from './Production';
import NonTerminal from './NonTerminal';
import ProdRef from './ProdRef';
import Grammar from './Grammar';
import Xref from './Xref';
import Eqn from './Eqn';
import Biblio from './Biblio';
import { autolink, replacerForNamespace, NO_CLAUSE_AUTOLINK } from './autolinker';
import { lint } from './lint/lint';
import { CancellationToken } from 'prex';
import type { JSDOM } from 'jsdom';

const DRAFT_DATE_FORMAT = { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' };
const STANDARD_DATE_FORMAT = { year: 'numeric', month: 'long', timeZone: 'UTC' };
const NO_EMD = new Set(['PRE', 'CODE', 'EMU-PRODUCTION', 'EMU-ALG', 'EMU-GRAMMAR', 'EMU-EQN']);

interface VisitorMap {
  [k: string]: BuilderInterface;
}

interface TextNodeContext {
  clause: Spec | Clause;
  node: Node;
  inAlg: boolean;
  currentId: string | null;
}

let builders: BuilderInterface[] = [
  Clause,
  H1,
  Algorithm,
  Xref,
  Dfn,
  Eqn,
  Grammar,
  Production,
  Example,
  Figure,
  NonTerminal,
  ProdRef,
  Note,
];

const visitorMap = builders.reduce((map, T) => {
  T.elements.forEach(e => (map[e] = T));
  return map;
}, {} as VisitorMap);

// NOTE: This is the public API for spec as used in the types. Do not remove.
export default interface Spec {
  spec: this;
  opts: Options;
  rootPath: string;
  rootDir: string;
  namespace: string;
  toHTML(): string;
  exportBiblio(): any;
}

export type Warning =
  | {
      type: 'global';
      ruleId: string;
      message: string;
    }
  | {
      type: 'node';
      node: Text | Element;
      ruleId: string;
      message: string;
    }
  | {
      type: 'attr';
      node: Element;
      attr: string;
      ruleId: string;
      message: string;
    }
  | {
      type: 'contents';
      node: Text | Element;
      ruleId: string;
      message: string;
      nodeRelativeLine: number;
      nodeRelativeColumn: number;
    }
  | {
      type: 'raw';
      ruleId: string;
      message: string;
      line: number;
      column: number;
      file?: string;
      source?: string;
    };

function wrapWarn(source: string, spec: Spec, warn: (err: EcmarkupError) => void) {
  return (e: Warning) => {
    let { message, ruleId } = e;
    let line: number | undefined;
    let column: number | undefined;
    let nodeType: string;
    let file: string | undefined = undefined;
    switch (e.type) {
      case 'global':
        line = undefined;
        column = undefined;
        nodeType = 'html';
        break;
      case 'raw':
        ({ line, column } = e);
        nodeType = 'html';
        if (e.file != null) {
          file = e.file;
          source = e.source!;
        }
        break;
      case 'node':
        if (e.node.nodeType === 3 /* Node.TEXT_NODE */) {
          let loc = spec.locate(e.node);
          if (loc) {
            file = loc.file;
            source = loc.source;
            ({ line, col: column } = loc);
          }
          nodeType = 'text';
        } else {
          let loc = spec.locate(e.node as Element);
          if (loc) {
            file = loc.file;
            source = loc.source;
            ({ line, col: column } = loc.startTag);
          }
          nodeType = (e.node as Element).tagName.toLowerCase();
        }
        break;
      case 'attr': {
        let loc = spec.locate(e.node);
        if (loc) {
          file = loc.file;
          source = loc.source;
          ({ line, column } = utils.attrValueLocation(source, loc, e.attr));
        }
        nodeType = e.node.tagName.toLowerCase();
        break;
      }
      case 'contents': {
        let { nodeRelativeLine, nodeRelativeColumn } = e;
        if (e.node.nodeType === 3 /* Node.TEXT_NODE */) {
          // i.e. a text node, which does not have a tag
          let loc = spec.locate(e.node);
          if (loc) {
            file = loc.file;
            source = loc.source;
            line = loc.line + nodeRelativeLine - 1;
            column = nodeRelativeLine === 1 ? loc.col + nodeRelativeColumn - 1 : nodeRelativeColumn;
          }
          nodeType = 'text';
        } else {
          let loc = spec.locate(e.node);
          if (loc) {
            file = loc.file;
            source = loc.source;
            // We have to adjust both for start of tag -> end of tag and end of tag -> passed position
            // TODO switch to using loc.startTag.end{Line,Col} once parse5 can be upgraded
            let tagSrc = source.slice(loc.startTag.startOffset, loc.startTag.endOffset);
            let tagEnd = utils.offsetToLineAndColumn(
              tagSrc,
              loc.startTag.endOffset - loc.startOffset
            );
            line = loc.startTag.line + tagEnd.line + nodeRelativeLine - 2;
            if (nodeRelativeLine === 1) {
              if (tagEnd.line === 1) {
                column = loc.startTag.col + tagEnd.column + nodeRelativeColumn - 2;
              } else {
                column = tagEnd.column + nodeRelativeColumn - 1;
              }
            } else {
              column = nodeRelativeColumn;
            }
          }
          nodeType = (e.node as Element).tagName.toLowerCase();
        }
        break;
      }
    }

    warn({
      message,
      ruleId,
      // we omit source for global errors so that we don't get a codeframe
      source: e.type === 'global' ? undefined : source,
      file,
      nodeType,
      line,
      column,
    });
  };
}

function isEmuImportElement(node: Node): node is EmuImportElement {
  return node.nodeType === 1 && node.nodeName === 'EMU-IMPORT';
}

/*@internal*/
export default class Spec {
  spec: this;
  opts: Options;
  rootPath: string;
  rootDir: string;
  sourceText: string;
  namespace: string;
  biblio: Biblio;
  dom: any; /* JSDOM types are not updated, this is the jsdom DOM object */
  doc: Document;
  imports: Import[];
  node: HTMLElement;
  nodeIds: Set<string>;
  subclauses: Clause[];
  replacementAlgorithmToContainedLabeledStepEntries: Map<Element, StepBiblioEntry[]>; // map from re to its labeled nodes
  labeledStepsToBeRectified: Set<string>;
  replacementAlgorithms: { element: Element; target: string }[];
  cancellationToken: CancellationToken;
  log: (msg: string) => void;
  warn: (err: Warning) => void | undefined;

  _figureCounts: { [type: string]: number };
  _xrefs: Xref[];
  _ntRefs: NonTerminal[];
  _prodRefs: ProdRef[];
  _textNodes: { [s: string]: [TextNodeContext] };
  private _fetch: (file: string, token: CancellationToken) => PromiseLike<string>;

  constructor(
    rootPath: string,
    fetch: (file: string, token: CancellationToken) => PromiseLike<string>,
    dom: any,
    opts: Options,
    sourceText: string,
    token = CancellationToken.none
  ) {
    opts = opts || {};

    this.spec = this;
    this.opts = {};
    this.rootPath = rootPath;
    this.rootDir = path.dirname(this.rootPath);
    this.sourceText = sourceText;
    this.doc = dom.window.document;
    this.dom = dom;
    this._fetch = fetch;
    this.subclauses = [];
    this.imports = [];
    this.node = this.doc.body;
    this.nodeIds = new Set();
    this.replacementAlgorithmToContainedLabeledStepEntries = new Map();
    this.labeledStepsToBeRectified = new Set();
    this.replacementAlgorithms = [];
    this.cancellationToken = token;
    this.log = opts.log ?? (() => {});
    this.warn = opts.warn ? wrapWarn(sourceText!, this, opts.warn) : () => {};
    this._figureCounts = {
      table: 0,
      figure: 0,
    };
    this._xrefs = [];
    this._ntRefs = [];
    this._prodRefs = [];
    this._textNodes = {};

    this.processMetadata();
    Object.assign(this.opts, opts);

    if (typeof this.opts.status === 'undefined') {
      this.opts.status = 'proposal';
    }

    if (typeof this.opts.toc === 'undefined') {
      this.opts.toc = true;
    }

    if (typeof this.opts.copyright === 'undefined') {
      this.opts.copyright = true;
    }

    if (typeof this.opts.ecma262Biblio === 'undefined') {
      this.opts.ecma262Biblio = true;
    }

    if (!this.opts.date) {
      this.opts.date = new Date();
    }

    if (this.opts.stage != undefined) {
      this.opts.stage = String(this.opts.stage);
    }

    if (!this.opts.location) {
      this.opts.location = '<no location>';
    }

    this.namespace = this.opts.location;

    this.biblio = new Biblio(this.opts.location);
  }

  public fetch(file: string) {
    return this._fetch(file, this.cancellationToken);
  }

  public async build() {
    /*
    The Ecmarkup build process proceeds as follows:

    1. Load biblios, making xrefs and auto-linking from external specs work
    2. Load imports by recursively inlining the import files' content into the emu-import element
    3. Generate boilerplate text
    4. Do a walk of the DOM visting elements and text nodes. Text nodes are replaced by text and HTML nodes depending
       on content. Elements are built by delegating to builders. Builders work by modifying the DOM ahead of them so
       the new elements they make are visited during the walk. Elements added behind the current iteration must be
       handled specially (eg. see static exit method of clause). Xref, nt, and prodref's are collected for linking
       in the next step.
    5. Linking. After the DOM walk we have a complete picture of all the symbols in the document so we proceed to link
       the various xrefs to the proper place.
    6. Adding charset, highlighting code, etc.
    7. Add CSS & JS dependencies.
    */

    this.log('Loading biblios...');
    if (this.opts.ecma262Biblio) {
      await this.loadECMA262Biblio();
    }
    await this.loadBiblios();

    this.log('Loading imports...');
    await this.loadImports();

    this.log('Building boilerplate...');
    this.buildBoilerplate();

    this.log('Walking document, building various elements...');
    const context: Context = {
      spec: this,
      node: this.doc.body,
      importStack: [],
      clauseStack: [],
      tagStack: [],
      clauseNumberer: ClauseNumbers(),
      inNoAutolink: false,
      inAlg: false,
      inNoEmd: false,
      startEmd: null,
      currentId: null,
    };

    const document = this.doc;

    if (this.opts.lintSpec) {
      this.log('Linting...');
      const source = this.sourceText;
      if (source === undefined) {
        throw new Error('Cannot lint when source text is not available');
      }
      await lint(this.warn, source, this, document);
    }

    const walker = document.createTreeWalker(document.body, 1 | 4 /* elements and text nodes */);

    await walk(walker, context);

    this.setReplacementAlgorithmOffsets();

    this.autolink();

    this.log('Linking xrefs...');
    this._xrefs.forEach(xref => xref.build());
    this.log('Linking non-terminal references...');
    this._ntRefs.forEach(nt => nt.build());
    this.log('Linking production references...');
    this._prodRefs.forEach(prod => prod.build());
    this.log('Building reference graph...');
    this.buildReferenceGraph();

    this.highlightCode();
    this.setCharset();
    this.setFirstH1Class();
    this.buildSpecWrapper();

    if (this.opts.toc) {
      this.log('Building table of contents...');

      let toc: Toc | Menu;
      if (this.opts.oldToc) {
        toc = new Toc(this);
      } else {
        toc = new Menu(this);
      }

      toc.build();
    }

    await this.buildAssets();

    return this;
  }

  public toHTML() {
    let htmlEle = this.doc.documentElement;
    return '<!doctype html>\n' + (htmlEle.hasAttributes() ? htmlEle.outerHTML : htmlEle.innerHTML);
  }

  public locate(
    node: Element | Node
  ): ({ file?: string; source: string } & MarkupData.ElementLocation) | undefined {
    let pointer: Element | Node | null = node;
    while (pointer != null) {
      if (isEmuImportElement(pointer)) {
        break;
      }
      pointer = pointer.parentElement;
    }
    if (pointer == null) {
      let loc = (this.dom as JSDOM).nodeLocation(node);
      if (loc) {
        // we can't just spread `loc` because not all properties are own/enumerable
        return {
          source: this.sourceText,
          startTag: loc.startTag,
          endTag: loc.endTag,
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          attrs: loc.attrs,
          line: loc.line,
          col: loc.col,
        };
      }
    } else if (pointer.dom) {
      let loc = pointer.dom.nodeLocation(node);
      if (loc) {
        return {
          file: pointer.importPath!,
          source: pointer.source!,
          startTag: loc.startTag,
          endTag: loc.endTag,
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          attrs: loc.attrs,
          line: loc.line,
          col: loc.col,
        };
      }
    }
  }

  private buildReferenceGraph() {
    let counter = 0;
    this._xrefs.forEach(xref => {
      let entry = xref.entry;
      if (!entry || entry.namespace === 'global') return;

      if (!entry.id && entry.refId) {
        entry = this.spec.biblio.byId(entry.refId);
      }

      if (!xref.id) {
        const id = `_ref_${counter++}`;
        xref.node.setAttribute('id', id);
        xref.id = id;
      }

      entry.referencingIds.push(xref.id);
    });

    this._ntRefs.forEach(prod => {
      const entry = prod.entry;
      if (!entry || entry.namespace === 'global') return;

      // if this is the defining nt of an emu-production, don't create a ref
      if (prod.node.parentNode!.nodeName === 'EMU-PRODUCTION') return;

      const id = `_ref_${counter++}`;
      prod.node.setAttribute('id', id);
      entry.referencingIds.push(id);
    });
  }

  private async buildAssets() {
    const jsContents = await concatJs();
    const cssContents = await utils.readFile(path.join(__dirname, '../css/elements.css'));

    if (this.opts.jsOut) {
      this.log(`Writing js file to ${this.opts.jsOut}...`);
      await utils.writeFile(this.opts.jsOut, jsContents);
    }

    if (this.opts.cssOut) {
      this.log(`Writing css file to ${this.opts.cssOut}...`);
      await utils.writeFile(this.opts.cssOut, cssContents);
    }

    if (this.opts.assets === 'none') return;

    // back-compat: if we already have a link to this script or css, bail out
    let skipJs = false,
      skipCss = false,
      outDir: string;

    if (this.opts.outfile) {
      outDir = path.dirname(this.opts.outfile);
    } else {
      outDir = process.cwd();
    }

    if (this.opts.jsOut) {
      const scripts = this.doc.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        const src = script.getAttribute('src');
        if (src && path.normalize(path.join(outDir, src)) === path.normalize(this.opts.jsOut)) {
          this.log(`Found existing js link to ${src}, skipping inlining...`);
          skipJs = true;
        }
      }
    }

    if (this.opts.cssOut) {
      const links = this.doc.querySelectorAll('link[rel=stylesheet]');
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        const href = link.getAttribute('href');
        if (href && path.normalize(path.join(outDir, href)) === path.normalize(this.opts.cssOut)) {
          this.log(`Found existing css link to ${href}, skipping inlining...`);
          skipCss = true;
        }
      }
    }

    if (!skipJs) {
      this.log('Inlining JavaScript assets...');
      const script = this.doc.createElement('script');
      script.textContent = jsContents;
      this.doc.head.appendChild(script);
    }

    if (!skipCss) {
      this.log('Inlining CSS assets...');
      const style = this.doc.createElement('style');
      style.textContent = cssContents;
      this.doc.head.appendChild(style);
    }
  }

  private buildSpecWrapper() {
    const elements = this.doc.body.childNodes;
    const wrapper = this.doc.createElement('div');
    wrapper.id = 'spec-container';

    while (elements.length > 0) {
      wrapper.appendChild(elements[0]);
    }

    this.doc.body.appendChild(wrapper);
  }

  private processMetadata() {
    const block = this.doc.querySelector('pre.metadata');

    if (!block || !block.parentNode) {
      return;
    }

    let data: any;
    try {
      data = yaml.safeLoad(block.textContent!);
    } catch (e) {
      if (typeof e?.mark.line === 'number' && typeof e?.mark.column === 'number') {
        this.warn({
          type: 'contents',
          ruleId: 'invalid-metadata',
          message: `metadata block failed to parse: ${e.reason}`,
          node: block,
          nodeRelativeLine: e.mark.line + 1,
          nodeRelativeColumn: e.mark.column + 1,
        });
      } else {
        this.warn({
          type: 'node',
          ruleId: 'invalid-metadata',
          message: 'metadata block failed to parse',
          node: block,
        });
      }
      return;
    } finally {
      block.parentNode.removeChild(block);
    }

    Object.assign(this.opts, data);
  }

  private async loadECMA262Biblio() {
    this.cancellationToken.throwIfCancellationRequested();
    await this.loadBiblio(path.join(__dirname, '../ecma262biblio.json'));
  }

  private async loadBiblios() {
    this.cancellationToken.throwIfCancellationRequested();
    await Promise.all(
      Array.from(this.doc.querySelectorAll('emu-biblio')).map(biblio =>
        this.loadBiblio(path.join(this.rootDir, biblio.getAttribute('href')!))
      )
    );
  }

  private async loadBiblio(file: string) {
    const contents = await this.fetch(file);
    this.biblio.addExternalBiblio(JSON.parse(contents));
  }

  private async loadImports() {
    await loadImports(this, this.spec.doc.body, this.rootDir);
  }

  public exportBiblio(): any {
    if (!this.opts.location) {
      this.warn({
        type: 'global',
        ruleId: 'no-location',
        message:
          "no spec location specified; biblio not generated. try --location or setting the location in the document's metadata block",
      });
      return {};
    }

    const biblio: BiblioData = {};
    biblio[this.opts.location] = this.biblio.toJSON();

    return biblio;
  }

  private highlightCode() {
    this.log('Highlighting syntax...');
    const codes = this.doc.querySelectorAll('pre code');
    for (let i = 0; i < codes.length; i++) {
      const classAttr = codes[i].getAttribute('class');
      if (!classAttr) continue;

      const lang = classAttr.replace(/lang(uage)?-/, '');
      let input = codes[i].textContent!;

      // remove leading and trailing blank lines
      input = input.replace(/^(\s*[\r\n])+|([\r\n]\s*)+$/g, '');

      // remove base inden based on indent of first non-blank line
      const baseIndent = input.match(/^\s*/) || '';
      const baseIndentRe = new RegExp('^' + baseIndent, 'gm');
      input = input.replace(baseIndentRe, '');

      const result = hljs.highlight(lang, input);
      codes[i].innerHTML = result.value;
      codes[i].setAttribute('class', classAttr + ' hljs');
    }
  }

  // if there is no text between body start and the first H1, the first H1 is given a class of "first"
  private setFirstH1Class() {
    const document = this.spec.doc;
    const walker = document.createTreeWalker(document.body, 1 | 4 /* elements and text nodes */);
    let node = walker.currentNode;
    while (node) {
      if (node.nodeType === 3 && node.textContent!.trim().length > 0) {
        return;
      }

      if (walker.currentNode.nodeType === 1 && walker.currentNode.nodeName === 'H1') {
        (node as HTMLElement).classList.add('first');
        return;
      }

      node = walker.nextNode()!;
    }
  }

  private buildBoilerplate() {
    this.cancellationToken.throwIfCancellationRequested();
    const status = this.opts.status!;
    const version = this.opts.version;
    const title = this.opts.title;
    const shortname = this.opts.shortname;
    const location = this.opts.location;
    const stage = this.opts.stage;

    if (this.opts.copyright) {
      if (status !== 'draft' && status !== 'standard' && !this.opts.contributors) {
        this.warn({
          type: 'global',
          ruleId: 'no-contributors',
          message:
            'contributors not specified, skipping copyright boilerplate. specify contributors in your frontmatter metadata',
        });
      } else {
        this.buildCopyrightBoilerplate();
      }
    }

    // no title boilerplate generated if title not specified
    if (!title) return;

    // title
    if (title && !this._updateBySelector('title', title)) {
      const titleElem = this.doc.createElement('title');
      titleElem.innerHTML = title;
      this.doc.head.appendChild(titleElem);

      const h1 = this.doc.createElement('h1');
      h1.setAttribute('class', 'title');
      h1.innerHTML = title;
      this.doc.body.insertBefore(h1, this.doc.body.firstChild);
    }

    // version string, ala 6th Edition July 2016 or Draft 10 / September 26, 2015
    let versionText = '';
    let omitShortname = false;
    if (version) {
      versionText += version + ' / ';
    } else if (status === 'proposal' && stage) {
      versionText += 'Stage ' + stage + ' Draft / ';
    } else if (shortname && status === 'draft') {
      versionText += 'Draft ' + shortname + ' / ';
      omitShortname = true;
    } else {
      return;
    }

    const defaultDateFormat = status === 'standard' ? STANDARD_DATE_FORMAT : DRAFT_DATE_FORMAT;
    const date = new Intl.DateTimeFormat('en-US', defaultDateFormat).format(this.opts.date);
    versionText += date;

    if (!this._updateBySelector('h1.version', versionText)) {
      const h1 = this.doc.createElement('h1');
      h1.setAttribute('class', 'version');
      h1.innerHTML = versionText;
      this.doc.body.insertBefore(h1, this.doc.body.firstChild);
    }

    // shortname and status, ala 'Draft ECMA-262
    if (shortname && !omitShortname) {
      // for proposals, link shortname to location
      const shortnameLinkHtml =
        status === 'proposal' && location ? `<a href="${location}">${shortname}</a>` : shortname;
      const shortnameHtml =
        status.charAt(0).toUpperCase() + status.slice(1) + ' ' + shortnameLinkHtml;

      if (!this._updateBySelector('h1.shortname', shortnameHtml)) {
        const h1 = this.doc.createElement('h1');
        h1.setAttribute('class', 'shortname');
        h1.innerHTML = shortnameHtml;
        this.doc.body.insertBefore(h1, this.doc.body.firstChild);
      }
    }
  }

  private buildCopyrightBoilerplate() {
    let address: string;
    let copyright: string;
    let license: string;

    let addressFile: string | undefined;
    let copyrightFile: string | undefined;
    let licenseFile: string | undefined;

    if (this.opts.boilerplate) {
      if (this.opts.boilerplate.address) {
        addressFile = path.join(process.cwd(), this.opts.boilerplate.address);
      }
      if (this.opts.boilerplate.copyright) {
        copyrightFile = path.join(process.cwd(), this.opts.boilerplate.copyright);
      }
      if (this.opts.boilerplate.license) {
        licenseFile = path.join(process.cwd(), this.opts.boilerplate.license);
      }
    }

    // Get content from files
    address = getBoilerplate(addressFile || 'address');
    copyright = getBoilerplate(copyrightFile || `${this.opts.status}-copyright`);
    license = getBoilerplate(licenseFile || 'software-license');

    if (this.opts.status === 'proposal') {
      address = '';
    }

    // Operate on content
    copyright = copyright.replace(/!YEAR!/g, '' + this.opts.date!.getFullYear());

    if (this.opts.contributors) {
      copyright = copyright.replace(/!CONTRIBUTORS!/g, this.opts.contributors);
    }

    let copyrightClause = this.doc.querySelector('.copyright-and-software-license');
    if (!copyrightClause) {
      let last: HTMLElement | undefined;
      utils.domWalkBackward(this.doc.body, node => {
        if (last) return false;
        if (node.nodeName === 'EMU-CLAUSE' || node.nodeName === 'EMU-ANNEX') {
          last = node as HTMLElement;
          return false;
        }
      });

      copyrightClause = this.doc.createElement('emu-annex');
      copyrightClause.setAttribute('id', 'sec-copyright-and-software-license');

      if (last && last.parentNode) {
        last.parentNode.insertBefore(copyrightClause, last.nextSibling);
      } else {
        this.doc.body.appendChild(copyrightClause);
      }
    }

    copyrightClause.innerHTML = `
      <h1>Copyright &amp; Software License</h1>
      ${address}
      <h2>Copyright Notice</h2>
      ${copyright.replace('!YEAR!', '' + this.opts.date!.getFullYear())}
      <h2>Software License</h2>
      ${license}
    `;
  }

  private setReplacementAlgorithmOffsets() {
    this.log('Finding offsets for replacement algorithm steps...');
    let pending: Map<string, Element[]> = new Map();

    let setReplacementAlgorithmStart = (element: Element, stepNumbers: number[]) => {
      let rootList = element.firstElementChild! as HTMLOListElement;
      rootList.start = stepNumbers[stepNumbers.length - 1];
      if (stepNumbers.length > 1) {
        // Note the off-by-one here: a length of 1 indicates we are replacing a top-level step, which means we do not need to adjust the styling.
        if (stepNumbers.length === 2) {
          rootList.classList.add('nested-once');
        } else if (stepNumbers.length === 3) {
          rootList.classList.add('nested-twice');
        } else if (stepNumbers.length === 4) {
          rootList.classList.add('nested-thrice');
        } else if (stepNumbers.length === 5) {
          rootList.classList.add('nested-four-times');
        } else {
          // At the sixth level and deeper (so once we have nested five times) we use a consistent line numbering style, so no further cases are necessary
          rootList.classList.add('nested-lots');
        }
      }

      // Fix up the biblio entries for any labeled steps in the algorithm
      for (let entry of this.replacementAlgorithmToContainedLabeledStepEntries.get(element)!) {
        entry.stepNumbers = [...stepNumbers, ...entry.stepNumbers.slice(1)];
        this.labeledStepsToBeRectified.delete(entry.id);

        // Now that we've figured out where the step is, we can deal with algorithms replacing it
        if (pending.has(entry.id)) {
          let todo = pending.get(entry.id)!;
          pending.delete(entry.id);
          for (let replacementAlgorithm of todo) {
            setReplacementAlgorithmStart(replacementAlgorithm, entry.stepNumbers);
          }
        }
      }
    };

    for (let { element, target } of this.replacementAlgorithms) {
      if (this.labeledStepsToBeRectified.has(target)) {
        if (!pending.has(target)) {
          pending.set(target, []);
        }
        pending.get(target)!.push(element);
      } else {
        // When the target is not itself within a replacement, or is within a replacement which we have already rectified, we can just use its step number directly
        let targetEntry = this.biblio.byId(target);
        if (targetEntry == null) {
          this.warn({
            type: 'attr',
            attr: 'replaces-step',
            ruleId: 'invalid-replacement',
            message: `could not find step ${JSON.stringify(target)}`,
            node: element,
          });
        } else if (targetEntry.type !== 'step') {
          this.warn({
            type: 'attr',
            attr: 'replaces-step',
            ruleId: 'invalid-replacement',
            message: `expected algorithm to replace a step, not a ${targetEntry.type}`,
            node: element,
          });
        } else {
          setReplacementAlgorithmStart(element, targetEntry.stepNumbers);
        }
      }
    }
    if (pending.size > 0) {
      // todo consider line/column missing cases
      this.warn({
        type: 'global',
        ruleId: 'invalid-replacement',
        message:
          'could not unambiguously determine replacement algorithm offsets - do you have a cycle in your replacement algorithms?',
      });
    }
  }

  public autolink() {
    this.log('Autolinking terms and abstract ops...');
    let namespaces = Object.keys(this._textNodes);
    for (let i = 0; i < namespaces.length; i++) {
      let namespace = namespaces[i];
      const [replacer, autolinkmap] = replacerForNamespace(namespace, this.biblio);
      let nodes = this._textNodes[namespace];

      for (let j = 0; j < nodes.length; j++) {
        const { node, clause, inAlg, currentId } = nodes[j];
        autolink(node, replacer, autolinkmap, clause, currentId, inAlg);
      }
    }
  }

  public setCharset() {
    let current = this.spec.doc.querySelector('meta[charset]');

    if (!current) {
      current = this.spec.doc.createElement('meta');
      this.spec.doc.head.insertBefore(current, this.spec.doc.head.firstChild);
    }

    current.setAttribute('charset', 'utf-8');
  }

  private _updateBySelector(selector: string, contents: string) {
    const elem = this.doc.querySelector(selector);
    if (elem && elem.textContent!.trim().length > 0) {
      return true;
    }

    if (elem) {
      elem.innerHTML = contents;
      return true;
    }

    return false;
  }
}

function getBoilerplate(file: string) {
  let boilerplateFile: string = file;

  try {
    if (fs.lstatSync(file).isFile()) {
      boilerplateFile = file;
    }
  } catch (error) {
    boilerplateFile = path.join(__dirname, '../boilerplate', `${file}.html`);
  }

  return fs.readFileSync(boilerplateFile, 'utf8');
}

async function loadImports(spec: Spec, rootElement: HTMLElement, rootPath: string) {
  let imports = rootElement.querySelectorAll('EMU-IMPORT');
  for (let i = 0; i < imports.length; i++) {
    let node = imports[i];
    let imp = await Import.build(spec, node as EmuImportElement, rootPath);
    await loadImports(spec, node as HTMLElement, imp.relativeRoot);
  }
}

async function walk(walker: TreeWalker, context: Context) {
  // When we set either of these states we need to know to unset when we leave the element.
  let changedInNoAutolink = false;
  let changedInNoEmd = false;
  const { spec } = context;

  context.node = walker.currentNode as HTMLElement;
  context.tagStack.push(context.node);

  if (context.node === context.startEmd) {
    context.startEmd = null;
    context.inNoEmd = false;
  }

  if (context.node.nodeType === 3) {
    // walked to a text node

    if (context.node.textContent!.trim().length === 0) return; // skip empty nodes; nothing to do!
    if (!context.inNoEmd) {
      // new nodes as a result of emd processing should be skipped
      context.inNoEmd = true;
      // inNoEmd is set to true when we walk to this node
      let node = context.node as Node | null;
      while (node && !node.nextSibling) {
        node = node.parentNode;
      }

      if (node) {
        context.startEmd = node.nextSibling;
      }
      // else, inNoEmd will just continue to the end of the file

      utils.emdTextNode(context.spec, (context.node as unknown) as Text);
    }

    if (!context.inNoAutolink) {
      // stuff the text nodes into an array for auto-linking with later
      // (since we can't autolink at this point without knowing the biblio).
      const clause = context.clauseStack[context.clauseStack.length - 1] || context.spec;
      const namespace = clause ? clause.namespace : context.spec.namespace;
      context.spec._textNodes[namespace] = context.spec._textNodes[namespace] || [];
      context.spec._textNodes[namespace].push({
        node: context.node,
        clause: clause,
        inAlg: context.inAlg,
        currentId: context.currentId,
      });
    }
    return;
  }

  // context.node is an HTMLElement (node type 1)

  // handle oldids
  let oldids = context.node.getAttribute('oldids');
  if (oldids) {
    if (!context.node.childNodes) {
      throw new Error('oldids found on unsupported element: ' + context.node.nodeName);
    }
    oldids
      .split(/,/g)
      .map(s => s.trim())
      .forEach(oid => {
        let s = spec.doc.createElement('span');
        s.setAttribute('id', oid);
        context.node.insertBefore(s, context.node.childNodes[0]);
      });
  }

  let parentId = context.currentId;
  if (context.node.hasAttribute('id')) {
    context.currentId = context.node.getAttribute('id');
  }

  // See if we should stop auto-linking here.
  if (NO_CLAUSE_AUTOLINK.has(context.node.nodeName) && !context.inNoAutolink) {
    context.inNoAutolink = true;
    changedInNoAutolink = true;
  }

  // check if entering a noEmd tag
  if (NO_EMD.has(context.node.nodeName) && !context.inNoEmd) {
    context.inNoEmd = true;
    changedInNoEmd = true;
  }

  const visitor = visitorMap[context.node.nodeName];
  if (visitor) {
    await visitor.enter(context);
  }

  const firstChild = walker.firstChild();
  if (firstChild) {
    while (true) {
      await walk(walker, context);
      const next = walker.nextSibling();
      if (!next) break;
    }
    walker.parentNode();
    context.node = walker.currentNode as HTMLElement;
  }

  if (visitor) visitor.exit(context);
  if (changedInNoAutolink) context.inNoAutolink = false;
  if (changedInNoEmd) context.inNoEmd = false;
  context.currentId = parentId;
  context.tagStack.pop();
}

const jsDependencies = ['menu.js', 'findLocalReferences.js'];
async function concatJs() {
  const dependencies = await Promise.all(
    jsDependencies.map(dependency => utils.readFile(path.join(__dirname, '../js/' + dependency)))
  );
  return dependencies.reduce((js, dependency) => js + dependency, '');
}
