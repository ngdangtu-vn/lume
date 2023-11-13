import { posix } from "../deps/path.ts";
import { normalizePath } from "./utils/path.ts";
import { mergeData } from "./utils/merge_data.ts";
import { parseDateFromFilename } from "./utils/date.ts";
import { getPageUrl } from "./utils/page_url.ts";
import { getPageDate } from "./utils/page_date.ts";
import { Page, StaticFile } from "./file.ts";

import type { Data, RawData } from "./file.ts";
import type { default as FS, Entry } from "./fs.ts";
import type Formats from "./formats.ts";
import type DataLoader from "./data_loader.ts";
import type { ScopeFilter } from "./scopes.ts";
import type {
  Components,
  default as ComponentLoader,
} from "./component_loader.ts";

export interface Options {
  formats: Formats;
  dataLoader: DataLoader;
  componentLoader: ComponentLoader;
  scopedData: Map<string, RawData>;
  scopedPages: Map<string, RawData[]>;
  scopedComponents: Map<string, Components>;
  fs: FS;
  prettyUrls: boolean;
  components: {
    variable: string;
    cssFile: string;
    jsFile: string;
  };
}

/**
 * Scan and load files from the source folder
 * with the data, pages, assets and static files
 */
export default class Source {
  /** Filesystem reader to scan folders */
  fs: FS;

  /** To load all _data files */
  dataLoader: DataLoader;

  /** To load all components */
  componentLoader: ComponentLoader;

  /** Info about how to handle different file formats */
  formats: Formats;

  /** The list of paths to ignore */
  ignored = new Set<string>();

  /** The path filters to ignore */
  filters: ScopeFilter[] = [];

  /** The data assigned per path */
  scopedData: Map<string, RawData>;

  /** The pages assigned per path */
  scopedPages: Map<string, RawData[]>;

  /** The components assigned per path */
  scopedComponents: Map<string, Components>;

  /** Use pretty URLs */
  prettyUrls: boolean;

  /** List of static files and folders to copy */
  staticPaths = new Map<
    string,
    { dest: string | ((path: string) => string) | undefined; dirOnly: boolean }
  >();

  /** List of static files and folders to copy */
  copyRemainingFiles?: (path: string) => string | boolean;

  /** Extra code generated by the components */
  extraCode = new Map<string, Map<string, string>>();

  components: {
    /** File name used to output the extra CSS code generated by the components */
    cssFile: string;

    /** File name used to output the extra JavaScript code generated by the components */
    jsFile: string;

    /** Variable name used to access to the components */
    variable: string;
  };

  /** The data assigned per path */
  data = new Map<string, Partial<Data>>();

  constructor(options: Options) {
    this.dataLoader = options.dataLoader;
    this.componentLoader = options.componentLoader;
    this.fs = options.fs;
    this.formats = options.formats;
    this.components = options.components;
    this.scopedData = options.scopedData;
    this.scopedPages = options.scopedPages;
    this.scopedComponents = options.scopedComponents;
    this.prettyUrls = options.prettyUrls;
  }

  addIgnoredPath(path: string) {
    this.ignored.add(normalizePath(path));
  }

  addIgnoreFilter(filter: ScopeFilter) {
    this.filters.push(filter);
  }

  addStaticPath(from: string, to?: string | ((path: string) => string)) {
    this.staticPaths.set(
      normalizePath(from.replace(/\/$/, "")),
      {
        dest: typeof to === "string" ? normalizePath(to) : to,
        dirOnly: from.endsWith("/"),
      },
    );
  }

  async build(...buildFilters: BuildFilter[]): Promise<[Page[], StaticFile[]]> {
    const pages: Page[] = [];
    const staticFiles: StaticFile[] = [];

    await this.#build(
      buildFilters,
      this.fs.entries.get("/")!,
      "/",
      new Map(),
      {},
      pages,
      staticFiles,
    );

    return [
      pages,
      staticFiles,
    ];
  }

  async #build(
    buildFilters: BuildFilter[],
    dir: Entry,
    path: string,
    parentComponents: Components,
    parentData: RawData,
    pages: Page[],
    staticFiles: StaticFile[],
  ) {
    if (buildFilters.some((filter) => !filter(dir))) {
      return;
    }

    // Parse the date/time in the folder name
    const [name, date] = parseDateFromFilename(dir.name);

    // Load the _data files
    const currentData: Partial<Data> = date ? { date } : {};

    for (const entry of dir.children.values()) {
      if (
        (entry.type === "file" && entry.name.startsWith("_data.")) ||
        (entry.type === "directory" && entry.name === "_data")
      ) {
        Object.assign(currentData, await this.dataLoader.load(entry));
      }
    }

    // Merge directory data
    const dirData = mergeData(
      parentData,
      date ? { date } : {},
      this.scopedData.get(dir.path) || {},
      currentData,
    ) as Partial<Data>;

    path = posix.join(path, dirData.slug ?? name);
    delete dirData.slug; // Slug doesn't have to propagate

    // Directory components
    const scopedComponents = this.scopedComponents.get(dir.path);
    let loadedComponents: Components | undefined;

    // Load _components files
    for (const entry of dir.children.values()) {
      if (entry.type === "directory" && entry.name === "_components") {
        loadedComponents = await this.componentLoader.load(entry, dirData);
        break;
      }
    }

    // Merge the components
    if (scopedComponents || loadedComponents) {
      parentComponents = mergeComponents(
        parentComponents,
        scopedComponents || new Map(),
        loadedComponents || new Map(),
      );

      dirData[this.components.variable] = toProxy(
        parentComponents,
        this.extraCode,
      );
    }

    // Store the root data to be used by other plugins
    this.data.set(path, dirData);

    // Load the pages assigned to the current path
    if (this.scopedPages.has(dir.path)) {
      for (const data of this.scopedPages.get(dir.path)!) {
        const page = new Page();
        page.data = mergeData(
          dirData,
          { date: new Date() },
          data,
        ) as Data;

        const url = getPageUrl(page, this.prettyUrls, path);
        if (!url) {
          continue;
        }
        page.data.url = url;
        page.data.date = getPageDate(page);
        page.data.page = page;
        pages.push(page);
      }
    }

    // Load the pages and static files
    for (const entry of dir.children.values()) {
      if (buildFilters.some((filter) => !filter(entry))) {
        continue;
      }

      // Static files
      if (this.staticPaths.has(entry.path)) {
        const { dest, dirOnly } = this.staticPaths.get(entry.path)!;

        if (entry.type === "file") {
          if (dirOnly) {
            continue;
          }
          staticFiles.push({
            entry,
            outputPath: getOutputPath(entry, path, dest),
          });
          continue;
        }

        staticFiles.push(...this.#getStaticFiles(
          entry,
          typeof dest === "string" ? dest : posix.join(path, entry.name),
          typeof dest === "function" ? dest : undefined,
        ));
        continue;
      }

      // Ignore .filename and _filename
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
        continue;
      }

      // Check if the file should be ignored
      if (this.ignored.has(entry.path)) {
        continue;
      }

      if (this.filters.some((filter) => filter(entry.path))) {
        continue;
      }

      if (entry.type === "file") {
        const format = this.formats.search(entry.path);

        // Unknown file format
        if (!format) {
          // Remaining files
          if (this.copyRemainingFiles) {
            const dest = this.copyRemainingFiles(entry.path);

            if (dest) {
              staticFiles.push({
                entry,
                outputPath: getOutputPath(
                  entry,
                  path,
                  typeof dest === "string" ? dest : undefined,
                ),
              });
            }
          }
          continue;
        }

        // The file is a static file
        if (format.copy) {
          staticFiles.push({
            entry,
            outputPath: getOutputPath(
              entry,
              path,
              typeof format.copy === "function" ? format.copy : undefined,
            ),
          });
          continue;
        }

        // The file is a page
        if (format.pageType) {
          const loader = format.pageType === "asset"
            ? format.assetLoader
            : format.loader;

          if (!loader) {
            throw new Error(
              `Missing loader for ${format.pageType} page type (${entry.path}))`,
            );
          }

          const { ext } = format;
          const [slug, date] = parseDateFromFilename(entry.name);

          // Create the page
          const page = new Page({
            path: entry.path.slice(0, -ext.length),
            ext,
            asset: format.pageType === "asset",
            slug: slug.slice(0, -ext.length),
            entry,
          });

          // Load and merge the page data
          const pageData = await entry.getContent(loader);
          page.data = mergeData(
            dirData,
            date ? { date } : {},
            this.scopedData.get(entry.path) || {},
            pageData,
          ) as Data;

          const url = getPageUrl(page, this.prettyUrls, path);
          if (!url) {
            continue;
          }
          page.data.url = url;
          page.data.date = getPageDate(page);
          page.data.page = page;
          page._data.layout = pageData.layout;

          if (buildFilters.some((filter) => !filter(entry, page))) {
            continue;
          }

          pages.push(page);
          continue;
        }
      }

      // Load recursively the directory
      if (entry.type === "directory") {
        await this.#build(
          buildFilters,
          entry,
          path,
          parentComponents,
          dirData,
          pages,
          staticFiles,
        );
      }
    }

    return [pages, staticFiles];
  }

  /** Returns the pages with extra code generated by the components */
  getComponentsExtraCode(): Page[] {
    const files = {
      css: this.components.cssFile,
      js: this.components.jsFile,
    };
    const pages: Page[] = [];

    for (const [type, path] of Object.entries(files)) {
      const code = this.extraCode.get(type);

      if (code && code.size) {
        pages.push(Page.create(path, Array.from(code.values()).join("\n")));
      }
    }

    return pages;
  }

  /** Scan the static files in a directory */
  *#getStaticFiles(
    dirEntry: Entry,
    destPath: string,
    destFn?: (file: string) => string,
  ): Generator<StaticFile> {
    for (const entry of dirEntry.children.values()) {
      if (entry.type === "file") {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
          continue;
        }

        // Check if the file should be ignored
        if (this.ignored.has(entry.path)) {
          continue;
        }

        if (this.filters.some((filter) => filter(entry.path))) {
          continue;
        }

        const outputPath = getOutputPath(entry, destPath, destFn);
        yield { entry, outputPath };
      }

      if (entry.type === "directory") {
        yield* this.#getStaticFiles(
          entry,
          posix.join(destPath, entry.name),
          destFn,
        );
      }
    }
  }
}

/**
 * Create and returns a proxy to use the components
 * as comp.name() instead of components.get("name").render()
 */
function toProxy(
  components: Components,
  extraCode?: Map<string, Map<string, string>>,
): ProxyComponents {
  const node = {
    _components: components,
    _proxies: new Map(),
  };
  return new Proxy(node, {
    get: (target, name) => {
      if (typeof name !== "string" || name in target) {
        return;
      }

      const key = name.toLowerCase();

      if (target._proxies.has(key)) {
        return target._proxies.get(key);
      }

      const component = target._components.get(key);

      if (!component) {
        throw new Error(`Component "${name}" not found`);
      }

      if (component instanceof Map) {
        const proxy = toProxy(component, extraCode);
        target._proxies.set(key, proxy);
        return proxy;
      }

      // Save CSS & JS code for the component
      if (extraCode) {
        if (component.css) {
          const code = extraCode.get("css") ?? new Map();
          code.set(key, component.css);
          extraCode.set("css", code);
        }

        if (component.js) {
          const code = extraCode.get("js") ?? new Map();
          code.set(key, component.js);
          extraCode.set("js", code);
        }
      }

      // Return the function to render the component
      return (props: Record<string, unknown>) => component.render(props);
    },
  }) as unknown as ProxyComponents;
}

export type BuildFilter = (entry: Entry, page?: Page) => boolean;

export interface ProxyComponents {
  (props?: Record<string, unknown>): string;
  [key: string]: ProxyComponents;
}

/** Merge the cascade components */
function mergeComponents(...components: Components[]): Components {
  return components.reduce((previous, current) => {
    const components = new Map(previous);

    for (const [key, value] of current) {
      if (components.has(key)) {
        const previousValue = components.get(key);

        if (previousValue instanceof Map && value instanceof Map) {
          components.set(key, mergeComponents(value, previousValue));
        } else {
          components.set(key, value);
        }
      } else {
        components.set(key, value);
      }
    }
    return components;
  });
}

function getOutputPath(
  entry: Entry,
  path: string,
  dest?: string | ((path: string) => string),
): string {
  if (typeof dest === "function") {
    return dest(posix.join(path, entry.name));
  }

  if (typeof dest === "string") {
    return dest;
  }

  return posix.join(path, entry.name);
}
