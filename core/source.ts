import { posix } from "../deps/path.ts";
import { getExtension, normalizePath } from "./utils.ts";
import { Page, StaticFile } from "./filesystem.ts";
import { parseISO } from "../deps/date.ts";
import { Exception } from "./errors.ts";

import type {
  ComponentLoader,
  Components,
  Data,
  DataLoader,
  Entry,
  Formats,
  FS,
  PageData,
  ScopeFilter,
} from "../core.ts";

export interface Options {
  formats: Formats;
  dataLoader: DataLoader;
  componentLoader: ComponentLoader;
  scopedData: Map<string, Data>;
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

  scopedData: Map<string, Data>;

  prettyUrls: boolean;

  /** List of static files and folders to copy */
  staticPaths = new Map<
    string,
    string | ((path: string) => string) | undefined
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

  rootData: Data | undefined;

  constructor(options: Options) {
    this.dataLoader = options.dataLoader;
    this.componentLoader = options.componentLoader;
    this.fs = options.fs;
    this.formats = options.formats;
    this.components = options.components;
    this.scopedData = options.scopedData;
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
      normalizePath(from),
      typeof to === "string" ? normalizePath(to) : to,
    );
  }

  async build(
    globalComponents: Components,
    pageFilters: ((page: Page) => boolean)[],
  ): Promise<[Page[], StaticFile[]]> {
    const pages: Page[] = [];
    const staticFiles: StaticFile[] = [];

    await this.#build(
      this.fs.entries.get("/")!,
      "",
      globalComponents,
      {},
      pages,
      staticFiles,
    );

    return [
      pages.filter((
        page,
      ) => pageFilters.every((filter) => filter(page))),
      staticFiles,
    ];
  }

  async #build(
    dir: Entry,
    path: string,
    parentComponents: Components,
    parentData: Data,
    pages: Page[],
    staticFiles: StaticFile[],
  ) {
    // Parse the date/time in the folder name
    const [name, date] = parseDate(dir.name);
    path = `${path}/${name}`;

    // Load the _data files
    const currentData: Data = date ? { date } : {};

    for (const entry of dir.children.values()) {
      if (
        (entry.type === "file" && entry.name.startsWith("_data.")) ||
        (entry.type === "directory" && entry.name === "_data")
      ) {
        Object.assign(currentData, await this.dataLoader.load(entry));
      }
    }

    const dirData = mergeData(
      this.scopedData.get(dir.path) || {},
      parentData,
      currentData,
    );

    // Load _components files
    for (const entry of dir.children.values()) {
      if (entry.type === "directory" && entry.name === "_components") {
        parentComponents = new Map(parentComponents);
        await this.componentLoader.load(entry, dirData, parentComponents);
        dirData[this.components.variable] = toProxy(
          parentComponents,
          this.extraCode,
        );
        break;
      }
    }

    // Store the root data to be used by other plugins
    if (path === "/") {
      this.rootData = dirData;
    }

    // Load the pages and static files
    for (const entry of dir.children.values()) {
      // Static files
      if (this.staticPaths.has(entry.path)) {
        const dest = this.staticPaths.get(entry.path);

        if (entry.type === "file") {
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
        if (format.pageLoader) {
          const info = entry.getInfo();
          const { ext, asset } = format;
          const [slug, date] = parseDate(entry.name);

          // Create the page
          const page = new Page({
            path: entry.path.slice(0, -ext.length),
            lastModified: info?.mtime || undefined,
            created: info?.birthtime || undefined,
            remote: entry.flags.has("remote") ? entry.src : undefined,
            ext,
            asset,
            slug: slug.replace(/\.[\w.]+$/, ""),
            entry,
          });

          // Load and merge the page data
          page.data = mergeData(
            dirData,
            date ? { date } : {},
            this.scopedData.get(entry.path) || {},
            await entry.getContent(format.pageLoader),
          ) as PageData;

          page.data.url = getUrl(page, this.prettyUrls, path);
          page.data.date = getDate(page.data.date, entry);
          page.data.page = page;

          pages.push(page);
          continue;
        }
      }

      // Load recursively the directory
      if (entry.type === "directory") {
        await this.#build(
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

export type ComponentFunction = (props: Record<string, unknown>) => string;

export interface ProxyComponents {
  [key: string]: ComponentFunction | ProxyComponents;
}

/** Merge the cascade components */
export function mergeComponents(
  current: Components,
  previous: Components = new Map(),
): Components {
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
}

/** Merge the cascade data */
export function mergeData(...datas: Data[]): PageData {
  return datas.reduce((previous, current) => {
    const data: Data = { ...previous, ...current };

    // Merge special keys
    const mergedKeys: Record<string, string> = {
      ...previous.mergedKeys,
      ...current.mergedKeys,
    };

    for (const [key, type] of Object.entries(mergedKeys)) {
      switch (type) {
        case "stringArray":
        case "array":
          {
            const currentValue: unknown[] = Array.isArray(current[key])
              ? current[key] as unknown[]
              : (key in current)
              ? [current[key]]
              : [];

            const previousValue: unknown[] = Array.isArray(previous[key])
              ? previous[key] as unknown[]
              : (key in previous)
              ? [previous[key]]
              : [];

            const merged = [...previousValue, ...currentValue];

            data[key] = [
              ...new Set(
                type === "stringArray" ? merged.map(String) : merged,
              ),
            ];
          }
          break;

        case "object":
          {
            const currentValue = current[key] as
              | Record<string, unknown>
              | undefined;
            const previousValue = previous[key] as
              | Record<string, unknown>
              | undefined;

            data[key] = { ...previousValue, ...currentValue };
          }
          break;
      }
    }

    return data;
  }) as PageData;
}

/**
 * Parse a date/datetime
 *
 * Filenames can be prepended with a date (yyyy-mm-dd) or datetime
 * (yyyy-mm-dd-hh-ii-ss) followed by an underscore (_) or hyphen (-).
 */
export function parseDate(slug: string): [string, Date | undefined] {
  const filenameRegex =
    /^(?<year>\d{4})-(?<month>\d\d)-(?<day>\d\d)(?:-(?<hour>\d\d)-(?<minute>\d\d)(?:-(?<second>\d\d))?)?(?:_|-)(?<slug>.*)/;
  const fileNameParts = filenameRegex.exec(slug)?.groups;

  if (fileNameParts) {
    const { year, month, day, hour, minute, second, slug } = fileNameParts;
    const date = new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      hour ? parseInt(hour) : 0,
      minute ? parseInt(minute) : 0,
      second ? parseInt(second) : 0,
    ));

    if (date) {
      return [slug, date];
    }
  }

  return [slug, undefined];
}

/** Returns the Date instance of a file */
export function getDate(date: unknown, entry?: Entry): Date {
  if (date instanceof Date) {
    return date;
  }

  if (typeof date === "number") {
    return new Date(date);
  }

  const info = entry?.getInfo();

  if (typeof date === "string") {
    if (entry && info) {
      switch (date.toLowerCase()) {
        case "git last modified":
          return getGitDate("modified", entry.src) || info.mtime || new Date();
        case "git created":
          return getGitDate("created", entry.src) || info.birthtime ||
            new Date();
      }
    }

    const parsed = parseISO(date);

    if (!isNaN(parsed.getTime())) {
      return parsed;
    }

    throw new Error(`Invalid date: ${date} (${entry?.src})`);
  }

  return info?.birthtime || info?.mtime || new Date();
}

/**
 * Returns the result of a git command as Date
 * Thanks to https://github.com/11ty/eleventy/blob/8dd2a1012de92c5ee1eab7c37e6bf1b36183927e/src/Util/DateGitLastUpdated.js
 */
export function getGitDate(
  type: "created" | "modified",
  file: string,
): Date | undefined {
  const args = type === "created"
    ? ["log", "--diff-filter=A", "--follow", "-1", "--format=%at", "--", file]
    : ["log", "-1", "--format=%at", "--", file];

  const { code, stdout } = new Deno.Command("git", { args }).outputSync();

  if (code !== 0) {
    return;
  }
  const str = new TextDecoder().decode(stdout);
  const timestamp = parseInt(str) * 1000;

  if (timestamp) {
    return new Date(timestamp);
  }
}

/** Returns the final URL assigned to a page */
export function getUrl(
  page: Page,
  prettyUrls: boolean,
  parentPath: string,
): string | false {
  const { data } = page;
  let url = data.url as
    | string
    | ((page: Page) => string | false)
    | false
    | undefined;

  if (url === false) {
    return false;
  }

  if (typeof url === "function") {
    url = url(page);
  }

  if (typeof url === "string") {
    // Relative URL
    if (url.startsWith("./") || url.startsWith("../")) {
      return normalizeUrl(posix.join(parentPath, url));
    }

    if (url.startsWith("/")) {
      return normalizeUrl(url);
    }

    throw new Exception(
      `The url variable must start with "/", "./" or "../"`,
      { page, url },
    );
  }

  // If the user has provided a value which hasn't yielded a string then it is an invalid url.
  if (url !== undefined) {
    throw new Exception(
      `If a url is specified, it should either be a string, or a function which returns a string. The provided url is of type: ${typeof url}.`,
      { page, url },
    );
  }

  // Calculate the URL from the path
  url = posix.join(parentPath, page.src.slug);
  const ext = getExtension(page.src.path);

  if (ext) {
    return url + ext;
  }

  if (page.src.asset) {
    return url + page.src.ext;
  }

  if (prettyUrls) {
    if (posix.basename(url) === "index") {
      return posix.join(posix.dirname(url), "/");
    }
    return posix.join(url, "/");
  }

  return `${url}.html`;
}

/** Remove the /index.html part if exist */
export function normalizeUrl(url: string): string {
  if (url.endsWith("/index.html")) {
    return url.slice(0, -10);
  }
  return url;
}

export function getOutputPath(
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
