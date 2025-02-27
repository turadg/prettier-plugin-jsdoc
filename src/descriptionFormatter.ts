import { Content, Image, Link, List, Root, Text } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { BuiltInParserName, format } from "prettier";
import { DESCRIPTION, EXAMPLE, TODO } from "./tags.js";
import { AllOptions } from "./types.js";
import { formatCode } from "./utils.js";

const TABLE = "2@^5!~#sdE!_TABLE";

interface DescriptionEndLineParams {
  tag: string;
  isEndTag: boolean;
}

const parserSynonyms = (lang: string): BuiltInParserName[] => {
  switch (lang) {
    case "js":
    case "javascript":
    case "jsx":
      return ["babel", "babel-flow", "vue"];
    case "ts":
    case "typescript":
    case "tsx":
      return ["typescript", "babel-ts", "angular"];
    case "json":
    case "css":
      return ["css"];
    case "less":
      return ["less"];
    case "scss":
      return ["scss"];
    case "html":
      return ["html"];
    case "yaml":
      return ["yaml"];
    default:
      return ["babel"];
  }
};

function descriptionEndLine({
  tag,
  isEndTag,
}: DescriptionEndLineParams): string {
  if ([DESCRIPTION, EXAMPLE, TODO].includes(tag) && !isEndTag) {
    return "\n";
  }

  return "";
}

interface FormatOptions {
  tagStringLength?: number;
  beginningSpace: string;
}

/**
 * Trim, make single line with capitalized text. Insert dot if flag for it is
 * set to true and last character is a word character
 *
 * @private
 */
async function formatDescription(
  tag: string,
  text: string,
  options: AllOptions,
  formatOptions: FormatOptions,
): Promise<string> {
  if (!text) return text;

  const { printWidth } = options;
  const { tagStringLength = 0, beginningSpace } = formatOptions;

  /**
   * change list with dash to dot for example:
   * 1- a thing
   *
   * to
   *
   * 1. a thing
   */
  text = text.replace(/^(\d+)[-][\s|]+/g, "$1. "); // Start
  text = text.replace(/\n+(\s*\d+)[-][\s]+/g, "\n$1. ");

  const fencedCodeBlocks = text.matchAll(/```\S*?\n[\s\S]+?```/gm);
  const indentedCodeBlocks = text.matchAll(
    /^\r?\n^(?:(?:(?:[ ]{4}|\t).*(?:\r?\n|$))+)/gm,
  );
  const allCodeBlocks = [...fencedCodeBlocks, ...indentedCodeBlocks];
  const tables: string[] = [];
  text = text.replace(
    /((\n|^)\|[\s\S]*?)((\n[^|])|$)/g,
    (code, _1, _2, _3, _, offs: number) => {
      // If this potential table is inside a code block, don't touch it
      for (const block of allCodeBlocks) {
        if (
          block.index !== undefined &&
          block.index <= offs + 1 &&
          offs + code.length + 1 <= block.index + block[0].length
        ) {
          return code;
        }
      }

      code = _3 ? code.slice(0, -1) : code;

      tables.push(code);
      return `\n\n${TABLE}\n\n${_3 ? _3.slice(1) : ""}`;
    },
  );

  text = `${tagStringLength ? `${"!".repeat(tagStringLength - 1)}?` : ""}${
    text.startsWith("```") ? "\n" : ""
  }${text}`;

  let tableIndex = 0;

  text = text.replace(
    new RegExp("\\n" + `[\u0020]{${beginningSpace.length}}`, "g"),
    "\n",
  );

  const rootAst = fromMarkdown(text);

  async function stringifyASTWithoutChildren(
    mdAst: Content | Root,
    intention: string,
    parent: Content | Root | null,
  ) {
    if (mdAst.type === "inlineCode") {
      return `\`${mdAst.value}\``;
    }

    if (mdAst.type === "code") {
      let result = mdAst.value || "";
      let _intention = intention;

      if (result) {
        // Remove two space from lines, maybe added previous format
        if (mdAst.lang) {
          const supportParsers = parserSynonyms(mdAst.lang.toLowerCase());
          const parser = supportParsers?.includes(options.parser as any)
            ? options.parser
            : supportParsers?.[0] || mdAst.lang;

          result = await formatCode(result, intention, {
            ...options,
            parser,
            jsdocKeepUnParseAbleExampleIndent: true,
          });
        } else if (options.jsdocPreferCodeFences || false) {
          result = await formatCode(result, _intention, {
            ...options,
            jsdocKeepUnParseAbleExampleIndent: true,
          });
        } else {
          _intention = intention + " ".repeat(4);

          result = await formatCode(result, _intention, {
            ...options,
            jsdocKeepUnParseAbleExampleIndent: true,
          });
        }
      }
      const addFence = options.jsdocPreferCodeFences || !!mdAst.lang;
      result = addFence ? result : result.trimEnd();
      return result
        ? addFence
          ? `\n\n${_intention}\`\`\`${mdAst.lang || ""}${result}\`\`\``
          : `\n${result}`
        : "";
    }

    if ((mdAst as Text).value === TABLE) {
      if (parent) {
        (parent as any).costumeType = TABLE;
      }

      if (tables.length > 0) {
        let result = tables?.[tableIndex] || "";
        tableIndex++;
        if (result) {
          result = (
            await format(result, {
              ...options,
              parser: "markdown",
            })
          ).trim();
        }
        return `${
          result
            ? `\n\n${intention}${result.split("\n").join(`\n${intention}`)}`
            : (mdAst as Text).value
        }`;
      }
    }

    if (mdAst.type === "break") {
      return `\\\n`;
    }

    return ((mdAst as Text).value ||
      (mdAst as Link).title ||
      (mdAst as Image).alt ||
      "") as string;
  }

  async function stringyfy(
    mdAst: Content | Root,
    intention: string,
    parent: Content | Root | null,
  ): Promise<string> {
    if (!Array.isArray((mdAst as Root).children)) {
      return stringifyASTWithoutChildren(mdAst, intention, parent);
    }

    return (
      await Promise.all(
        ((mdAst as Root).children as Content[]).map(async (ast, index) => {
          switch (ast.type) {
            case "listItem": {
              let _listCount = `\n${intention}- `;
              // .replace(/((?!(^))\n)/g, "\n" + _intention);
              if (typeof (mdAst as List).start === "number") {
                const count = index + (((mdAst as List).start as number) ?? 1);
                _listCount = `\n${intention}${count}. `;
              }

              const _intention = intention + " ".repeat(_listCount.length - 1);

              const result = (await stringyfy(ast, _intention, mdAst)).trim();

              return `${_listCount}${result}`;
            }

            case "list": {
              let end = "";
              /**
               * Add empty line after list if that is end of description
               * issue: {@link https://github.com/hosseinmd/prettier-plugin-jsdoc/issues/98}
               */
              if (
                tag !== DESCRIPTION &&
                mdAst.type === "root" &&
                index === mdAst.children.length - 1
              ) {
                end = "\n";
              }
              return `\n${await stringyfy(ast, intention, mdAst)}${end}`;
            }

            case "paragraph": {
              const paragraph = await stringyfy(ast, intention, parent);
              if ((ast as any).costumeType === TABLE) {
                return paragraph;
              }

              return `\n\n${paragraph
                /**
                 * Break by backslash\
                 * issue: https://github.com/hosseinmd/prettier-plugin-jsdoc/issues/102
                 */
                .split("\\\n")
                .map((_paragraph) => {
                  const links: string[] = [];
                  // Find jsdoc links and remove spaces
                  _paragraph = _paragraph.replace(
                    /{@(link|linkcode|linkplain)[\s](([^{}])*)}/g,
                    (_, tag: string, link: string) => {
                      links.push(link);

                      return `{@${tag}${"_".repeat(link.length)}}`;
                    },
                  );

                  _paragraph = _paragraph.replace(/\s+/g, " "); // Make single line

                  if (options.jsdocDescriptionWithDot)
                    _paragraph = _paragraph.replace(/([\w\p{L}])$/u, "$1."); // Insert dot if needed

                  let result = breakDescriptionToLines(
                    _paragraph,
                    printWidth,
                    intention,
                  );

                  // Replace links
                  result = result.replace(
                    /{@(link|linkcode|linkplain)([_]+)}/g,
                    (original: string, tag: string, underline: string) => {
                      const link = links[0];

                      if (link.length === underline.length) {
                        links.shift();
                        return `{@${tag} ${link}}`;
                      }

                      return original;
                    },
                  );

                  return result;
                })
                .join("\\\n")}`;
            }

            case "strong": {
              return `**${await stringyfy(ast, intention, mdAst)}**`;
            }

            case "emphasis": {
              return `_${await stringyfy(ast, intention, mdAst)}_`;
            }

            case "heading": {
              return `\n\n${intention}${"#".repeat(
                ast.depth,
              )} ${await stringyfy(ast, intention, mdAst)}`;
            }

            case "link":
            case "image": {
              return `[${await stringyfy(ast, intention, mdAst)}](${ast.url})`;
            }

            case "linkReference": {
              return `[${await stringyfy(ast, intention, mdAst)}][${
                ast.label
              }]`;
            }
            case "definition": {
              return `\n\n[${ast.label}]: ${ast.url}`;
            }

            case "blockquote": {
              const paragraph = await stringyfy(ast, "", mdAst);
              return `${intention}> ${paragraph
                .trim()
                .replace(/(\n+)/g, `$1${intention}> `)}`;
            }
          }
          return stringyfy(ast, intention, mdAst);
        }),
      )
    ).join("");
  }

  let result = await stringyfy(rootAst, beginningSpace, null);

  result = result.replace(/^[\s\n]+/g, "");
  result = result.replace(/^([!]+\?)/g, "");

  return result;
}

function breakDescriptionToLines(
  desContent: string,
  maxWidth: number,
  beginningSpace: string,
): string {
  let str = desContent.trim();

  if (!str) {
    return str;
  }

  let result = "";
  while (str.length > maxWidth) {
    let sliceIndex = str.lastIndexOf(
      " ",
      str.startsWith("\n") ? maxWidth + 1 : maxWidth,
    );
    /**
     * When a str is a long word lastIndexOf will gives 4 every time loop
     * running unlimited time
     */
    if (sliceIndex <= beginningSpace.length)
      sliceIndex = str.indexOf(" ", beginningSpace.length + 1);

    if (sliceIndex === -1) sliceIndex = str.length;

    result += str.substring(0, sliceIndex);
    str = str.substring(sliceIndex + 1);
    if (str) {
      str = `${beginningSpace}${str}`;
      str = `\n${str}`;
    }
  }

  result += str;

  return `${beginningSpace}${result}`;
}

export { FormatOptions, descriptionEndLine, formatDescription };
