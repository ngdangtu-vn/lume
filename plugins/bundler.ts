import { merge } from "../core/utils.ts";
import { Page, Site } from "../core.ts";
import { toFileUrl } from "../deps/path.ts";
import { createGraph, load, LoadResponse } from "../deps/graph.ts";
import { SitePage } from "../core/filesystem.ts";

export interface Options {
  /** The list of extensions this plugin applies to */
  extensions: string[];

  /** Set `true` to generate source map files */
  sourceMap: boolean;

  /** The options for Deno.emit */
  options: Deno.EmitOptions;

  /** Includes paths */
  includes: Record<string, string>;
}

// Default options
const defaults: Options = {
  extensions: [".ts", ".js"],
  sourceMap: false,
  options: {},
  includes: {},
};

/** A plugin to load all .js and .ts files and bundle them using Deno.emit() */
export default function (userOptions?: Partial<Options>) {
  const options = merge(defaults, userOptions);

  return (site: Site) => {
    const sources: Record<string, string> = {};
    const imports: Record<string, string> = {};

    for (const [specifier, location] of Object.entries(options.includes)) {
      imports[specifier] = toFileUrl(site.src(location)).href;
    }

    site.loadAssets(options.extensions);

    /**
     * For bundle, we need to load all the files sources
     * before emit the entries
     */
    if (options.options.bundle) {
      // Load all source files and save the content in `sources`
      site.process(options.extensions, (file: Page) => {
        const specifier = getSpecifier(file);
        sources[specifier] = file.content as string;
      });

      // Load all other dependencies and save the content in `sources`
      site.process(options.extensions, async (file: Page) => {
        const specifier = getSpecifier(file);

        await createGraph(specifier, {
          resolve(specifier, referrer) {
            return isBare(specifier)
              ? getFileSpecifier(specifier)
              : new URL(specifier, referrer).href;
          },
          async load(
            specifier: string,
            isDynamic: boolean,
          ): Promise<LoadResponse | undefined> {
            if (isDynamic) {
              return;
            }
            if (specifier in sources) {
              return {
                specifier: specifier,
                content: sources[specifier],
              };
            }

            const response = await load(specifier);

            if (response) {
              sources[specifier] = response.content;
              return response;
            }
          },
        });
      });
    }

    // Now we are ready to emit the entries
    site.process(options.extensions, async (file: Page) => {
      const specifier = getSpecifier(file);
      const { files } = await Deno.emit(specifier, {
        ...options.options,
        sources: {
          ...sources,
          [specifier]: file.content as string,
        },
        importMap: { imports },
        importMapPath: site.src(),
      });

      const content = files[specifier] || files[specifier + ".js"] ||
        files["deno:///bundle.js"];

      if (content) {
        file.content = fixExtensions(content);
        file.dest.ext = ".js";
      }

      const mapContent = files[specifier + ".map"] ||
        files[specifier + ".js.map"] || files["deno:///bundle.js.map"];

      if (options.sourceMap && mapContent) {
        const mapFile = new SitePage();
        mapFile.dest = {
          path: file.dest.path,
          ext: ".js.map",
        };
        mapFile.content = mapContent;
        site.pages.push(mapFile);
      }
    });

    function getSpecifier(file: Page) {
      file._data.specifier ||=
        toFileUrl(site.src(file.data.url as string)).href;
      return file._data.specifier as string;
    }

    function getFileSpecifier(file: string) {
      for (const key in imports) {
        if (file.startsWith(key)) {
          return imports[key] + file.slice(key.length);
        }
      }
      throw new Error(`Invalid specifier ${file}`);
    }
  };
}

/** Replace all .ts, .tsx and .jsx files with .js files */
function fixExtensions(content: string) {
  return content.replaceAll(/\.(ts|tsx|jsx)("|')/ig, ".js$2");
}

function isBare(specifier: string) {
  return !specifier.startsWith(".") && !specifier.includes("://");
}
