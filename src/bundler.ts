/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import * as dom5 from 'dom5';
import * as parse5 from 'parse5';
import {ASTNode} from 'parse5';
import {Analyzer} from 'polymer-analyzer';
import {FSUrlLoader} from 'polymer-analyzer/lib/url-loader/fs-url-loader';

import * as astUtils from './ast-utils';
import * as bundleManifestLib from './bundle-manifest';
import {AssignedBundle, Bundle, BundleManifest, BundleStrategy, BundleUrlMapper} from './bundle-manifest';
import * as depsIndexLib from './deps-index';
import {BundledDocument, DocumentCollection} from './document-collection';
import * as importUtils from './import-utils';
import * as matchers from './matchers';
import * as urlUtils from './url-utils';
import {UrlString} from './url-utils';


// TODO(usergenic): resolve <base> tags.
// TODO(garlicnation): find transitive dependencies of specified excluded files.
// TODO(garlicnation): ignore <link> in <template>
// TODO(garlicnation): Add noopResolver for external urls.
// TODO(garlicnation): Add noopResolver for excluded urls.
// TODO(garlicnation): Add redirectResolver for fakeprotocol:// urls
// TODO(usergenic): Add plylog
export interface Options {
  // The instance of the Polymer Analyzer which has completed analysis
  analyzer?: Analyzer;

  // URLs of files that should not be inlined.
  excludes?: UrlString[];

  // *DANGEROUS*! Avoid stripping imports of the transitive dependencies of
  // excluded imports (i.e. where listed in `excludes` option or where contained
  // in a folder/descendant of the `excludes` array.)  May result in duplicate
  // javascript inlining.
  noImplicitStrip?: boolean;

  // When true, inline external CSS file contents into <style> tags in the
  // output document.
  inlineCss?: boolean;

  // When true, inline external Javascript file contents into <script> tags in
  // the output document.
  inlineScripts?: boolean;

  // Remove of all comments (except those containing '@license') when true.
  stripComments?: boolean;

  // URLs of files that should not be inlined and which should have all links
  // removed.
  stripExcludes?: UrlString[];
}

export class Bundler {
  analyzer: Analyzer;
  enableCssInlining: boolean;
  enableScriptInlining: boolean;
  excludes: UrlString[];
  implicitStrip: boolean;
  stripComments: boolean;
  stripExcludes: UrlString[];

  constructor(options?: Options) {
    const opts = options ? options : {};
    this.analyzer = opts.analyzer ?
        opts.analyzer :
        new Analyzer({urlLoader: new FSUrlLoader()});

    // implicitStrip should be true by default
    this.implicitStrip = !Boolean(opts.noImplicitStrip);

    this.excludes = Array.isArray(opts.excludes) ? opts.excludes : [];
    this.stripComments = Boolean(opts.stripComments);
    this.enableCssInlining = Boolean(opts.inlineCss);
    this.enableScriptInlining = Boolean(opts.inlineScripts);
  }

  /**
   * Given urls to entrypoint html documents, produce a collection of bundled
   * documents with HTML imports, external stylesheets and external scripts
   * inlined according to the options for this Bundler.
   *
   * @param {Array<string>} entrypoints The list of entrypoints that will be
   *     analyzed for dependencies. The results of the analysis will be passed
   *     to the `strategy`.
   * @param {BundleStrategy} strategy The strategy used to construct the
   *     output bundles. See 'polymer-analyzer/src/bundle-manifest'.
   * @param {BundleUrlMapper} mapper A function that produces urls for the
   *     generated bundles. See 'polymer-analyzer/src/bundle-manifest'.
   */
  async bundle(
      entrypoints: UrlString[],
      strategy?: BundleStrategy,
      mapper?: BundleUrlMapper): Promise<DocumentCollection> {
    // TODO(usergenic): Expose the generateBundleManifest operation
    // as public and make the interface for bundle method take a manifest.
    const manifest =
        await this._generateBundleManifest(entrypoints, strategy, mapper);

    const bundledDocuments: DocumentCollection =
        new Map<string, BundledDocument>();

    for (const bundleEntry of manifest.bundles) {
      const bundleUrl = bundleEntry[0];
      const bundle = {url: bundleUrl, bundle: bundleEntry[1]};
      const bundledAst =
          await this._bundleDocument(bundle, manifest, bundle.bundle.files);
      bundledDocuments.set(
          bundleUrl, {ast: bundledAst, files: Array.from(bundle.bundle.files)});
    }

    return bundledDocuments;
  }

  /**
   * Add HTML Import elements for each file in the bundle.  We append all the
   * imports in the case any were moved into the bundle by the strategy.
   * While this will almost always yield duplicate imports, they will be
   * cleaned up through deduplication during the import phase.
   */
  private _appendHtmlImportsForBundle(
      document: ASTNode,
      bundle: AssignedBundle) {
    for (const importUrl of bundle.bundle.files) {
      const newUrl = urlUtils.relativeUrl(bundle.url, importUrl);
      if (!newUrl) {
        continue;
      }
      this._appendHtmlImport(this._findOrCreateHiddenDiv(document), newUrl);
    }
  }

  /**
   * Append a <link rel="import" node to `node` with a value of `url` for
   * the "href" attribute.
   */
  private _appendHtmlImport(node: ASTNode, url: UrlString) {
    const newNode = dom5.constructors.element('link');
    dom5.setAttribute(newNode, 'rel', 'import');
    dom5.setAttribute(newNode, 'href', url);
    dom5.append(node, newNode);
  }

  /**
   * Set the hidden div at the appropriate location within the document.  The
   * goal is to place the hidden div at the same place as the first html
   * import.  However, the div can't be placed in the `<head>` of the document
   * so if first import is found in the head, we prepend the div to the body.
   * If there is no body, we'll just attach the hidden div to the document at
   * the end.
   */
  private _attachHiddenDiv(document: ASTNode, hiddenDiv: ASTNode) {
    const firstHtmlImport = dom5.query(document, matchers.htmlImport);
    const body = dom5.query(document, matchers.body);
    if (body) {
      if (firstHtmlImport &&
          dom5.predicates.parentMatches(matchers.body)(firstHtmlImport)) {
        astUtils.insertAfter(firstHtmlImport, hiddenDiv);
      } else {
        astUtils.prepend(body, hiddenDiv);
      }
    } else {
      dom5.append(document, hiddenDiv);
    }
  }

  /**
   * Produces a document containing the content of all of the bundle's files.
   * If the bundle's url resolves to an existing html file, that file will be
   * used as the basis for the generated document.
   */
  private async _bundleDocument(
      docBundle: AssignedBundle,
      bundleManifest: BundleManifest,
      bundleImports?: Set<string>): Promise<ASTNode> {
    const docUrl = docBundle.url;
    const document = await this._prepareBundleDocument(docBundle);
    this._appendHtmlImportsForBundle(document, docBundle);
    importUtils.rewriteImportedUrls(document, docUrl, docUrl);

    await this._inlineHtmlImports(docUrl, document, docBundle, bundleManifest);

    if (this.enableScriptInlining) {
      await this._inlineScripts(docUrl, document);
    }
    if (this.enableCssInlining) {
      await this._inlineStylesheetLinks(docUrl, document);
      await this._inlineStylesheetImports(docUrl, document);
    }

    if (this.stripComments) {
      astUtils.stripComments(document);
    }
    return document;
  }

  /**
   * Creates a hidden container <div> to which inlined content will be
   * appended.
   */
  private _createHiddenDiv(): ASTNode {
    const hidden = dom5.constructors.element('div');
    dom5.setAttribute(hidden, 'hidden', '');
    dom5.setAttribute(hidden, 'by-polymer-bundler', '');
    return hidden;
  }

  /**
   * Given an array of Bundles, remove all files from bundles which are in the
   * "excludes" set.  Remove any bundles which are left empty after excluded
   * files are removed.
   */
  private _filterExcludesFromBundles(bundles: Bundle[]) {
    // Remove excluded files from bundles.
    for (const bundle of bundles) {
      for (const exclude of this.excludes) {
        bundle.files.delete(exclude);
      }
    }

    let b = 0;
    while (b < bundles.length) {
      if (bundles[b].files.size < 0) {
        bundles.splice(b, 1);
        continue;
      }
      ++b;
    }
  }

  /**
   * Given a document, search for the hidden div, if it isn't found, then
   * create it.  After creating it, attach it to the desired location.  Then
   * return it.
   */
  private _findOrCreateHiddenDiv(document: ASTNode): ASTNode {
    const hiddenDiv =
        dom5.query(document, matchers.hiddenDiv) || this._createHiddenDiv();
    if (!hiddenDiv.parentNode) {
      this._attachHiddenDiv(document, hiddenDiv);
    }
    return hiddenDiv;
  }

  /**
   * Generates a BundleManifest with all bundles defined, using entrypoints,
   * strategy and mapper.
   */
  private async _generateBundleManifest(
      entrypoints: UrlString[],
      strategy?: BundleStrategy,
      mapper?: BundleUrlMapper): Promise<BundleManifest> {
    if (!strategy) {
      strategy = bundleManifestLib.generateSharedDepsMergeStrategy();
    }
    if (!mapper) {
      mapper = bundleManifestLib.sharedBundleUrlMapper;
    }
    const dependencyIndex =
        await depsIndexLib.buildDepsIndex(entrypoints, this.analyzer);
    let bundles =
        bundleManifestLib.generateBundles(dependencyIndex.entrypointToDeps);
    this._filterExcludesFromBundles(bundles);
    bundles = strategy(bundles);
    return new BundleManifest(bundles, mapper);
  }

  /**
   * Replace html import links in the document with the contents of the
   * imported file, but only once per url.
   */
  private async _inlineHtmlImports(
      url: UrlString,
      document: ASTNode,
      bundle: AssignedBundle,
      bundleManifest: BundleManifest) {
    const visitedUrls = new Set<UrlString>();
    const htmlImports = dom5.queryAll(document, matchers.htmlImport);
    for (const htmlImport of htmlImports) {
      await importUtils.inlineHtmlImport(
          url,
          htmlImport,
          visitedUrls,
          bundle,
          bundleManifest,
          this._loadFileContents.bind(this));
    }
  }

  /**
   * Replace all external javascript tags (`<script src="...">`)
   * with `<script>` tags containing the file contents inlined.
   */
  private async _inlineScripts(url: UrlString, document: ASTNode) {
    const scriptImports = dom5.queryAll(document, matchers.externalJavascript);
    for (const externalScript of scriptImports) {
      await importUtils.inlineScript(
          url, externalScript, this._loadFileContents.bind(this));
    }
  }

  /**
   * Replace all polymer stylesheet imports (`<link rel="import" type="css">`)
   * with `<style>` tags containing the file contents, with internal URLs
   * relatively transposed as necessary.
   */
  private async _inlineStylesheetImports(url: UrlString, document: ASTNode) {
    const cssImports = dom5.queryAll(document, matchers.stylesheetImport);
    for (const cssLink of cssImports) {
      const style = await importUtils.inlineStylesheet(
          url, cssLink, this._loadFileContents.bind(this));
      if (style) {
        this._moveDomModuleStyleIntoTemplate(style);
      }
    }
  }

  /**
   * Replace all external stylesheet references, in `<link rel="stylesheet">`
   * tags with `<style>` tags containing file contents, with internal URLs
   * relatively transposed as necessary.
   */
  private async _inlineStylesheetLinks(url: UrlString, document: ASTNode) {
    const cssLinks = dom5.queryAll(document, matchers.externalStyle);
    for (const cssLink of cssLinks) {
      await importUtils.inlineStylesheet(
          url, cssLink, this._loadFileContents.bind(this));
    }
  }

  /**
   * Return a file's contents as a string, given its url.
   */
  private async _loadFileContents(url: UrlString): Promise<string> {
    const analyzedDocument = await this.analyzer.analyze(url);
    return analyzedDocument.parsedDocument.contents;
  }

  /**
   * Old Polymer supported `<style>` tag in `<dom-module>` but outside of
   * `<template>`.  This is also where the deprecated Polymer CSS import tag
   * `<link rel="import" type="css">` would generate inline `<style>`.
   * Migrates these `<style>` tags into available `<template>` of the
   * `<dom-module>`.  Will create a `<template>` container if not present.
   *
   * TODO(usergenic): Why is this in bundler... shouldn't this be some kind of
   * polyup or pre-bundle operation?
   */
  private _moveDomModuleStyleIntoTemplate(style: ASTNode) {
    const domModule =
        dom5.nodeWalkAncestors(style, dom5.predicates.hasTagName('dom-module'));
    if (!domModule) {
      return;
    }
    let template = dom5.query(domModule, matchers.template);
    if (!template) {
      template = dom5.constructors.element('template')!;
      dom5.append(domModule, template);
    }
    astUtils.removeElementAndNewline(style);
    astUtils.prepend(template, style);
  }

  /**
   * When an HTML Import is encountered in the head of the document, it needs
   * to be moved into the hidden div and any subsequent order-dependent
   * imperatives (imports, styles, scripts) must also be move into the
   * hidden div.
   */
  private _moveOrderedImperativesFromHeadIntoHiddenDiv(document: ASTNode) {
    const head = dom5.query(document, matchers.head);
    if (!head) {
      return;
    }
    const firstHtmlImport = dom5.query(head, matchers.htmlImport);
    if (!firstHtmlImport) {
      return;
    }
    for (const node of [firstHtmlImport].concat(
             astUtils.siblingsAfter(firstHtmlImport))) {
      if (matchers.orderedImperative(node)) {
        astUtils.removeElementAndNewline(node);
        dom5.append(this._findOrCreateHiddenDiv(document), node);
      }
    }
  }

  /**
   * Move any remaining htmlImports that are not inside the hidden div
   * already, into the hidden div.
   */
  private _moveUnhiddenHtmlImportsIntoHiddenDiv(document: ASTNode) {
    const unhiddenHtmlImports = dom5.queryAll(
        document,
        dom5.predicates.AND(
            matchers.htmlImport, dom5.predicates.NOT(matchers.inHiddenDiv)));
    for (const htmlImport of unhiddenHtmlImports) {
      astUtils.removeElementAndNewline(htmlImport);
      dom5.append(this._findOrCreateHiddenDiv(document), htmlImport);
    }
  }

  /**
   * Generate a fresh document (ASTNode) to bundle contents into.
   * If we're building a bundle which is based on an existing file, we
   * should load that file and prepare it as the bundle document, otherwise
   * we'll create a clean/empty html document.
   */
  private async _prepareBundleDocument(bundle: AssignedBundle):
      Promise<ASTNode> {
    const html = bundle.bundle.files.has(bundle.url) ?
        await this._loadFileContents(bundle.url) :
        '';
    const document = parse5.parse(html);
    this._moveOrderedImperativesFromHeadIntoHiddenDiv(document);
    this._moveUnhiddenHtmlImportsIntoHiddenDiv(document);
    return document;
  }
}
