import { parse, Spec, Block, tokenizers } from "comment-parser";
import {
  addStarsToTheBeginningOfTheLines,
  convertToModernType,
  formatType,
  detectEndOfLine,
  findPluginByParser,
  isDefaultTag,
} from "./utils.js";
import { DESCRIPTION } from "./tags.js";
import {
  TAGS_DESCRIPTION_NEEDED,
  TAGS_NAMELESS,
  TAGS_ORDER,
  TAGS_SYNONYMS,
  TAGS_TYPELESS,
} from "./roles.js";
import { AST, AllOptions, PrettierComment } from "./types.js";
import { stringify } from "./stringify.js";
import { Parser } from "prettier";

const {
  name: nameTokenizer,
  tag: tagTokenizer,
  type: typeTokenizer,
  description: descriptionTokenizer,
} = tokenizers;

/** @link https://prettier.io/docs/en/api.html#custom-parser-api} */
export const getParser = (originalParse: Parser["parse"], parserName: string) =>
  async function jsdocParser(
    text: string,
    parsersOrOptions: Parameters<Parser["parse"]>[1],
    maybeOptions?: AllOptions,
  ): Promise<AST> {
    let options = (maybeOptions ?? parsersOrOptions) as AllOptions;
    const prettierParse =
      findPluginByParser(parserName, options)?.parse || originalParse;

    const ast = prettierParse(text, options) as AST;

    options = {
      ...options,
    };

    const eol =
      options.endOfLine === "auto" ? detectEndOfLine(text) : options.endOfLine;
    options = { ...options, endOfLine: "lf" };

    await Promise.all(
      ast.comments.map(async (comment) => {
        if (!isBlockComment(comment)) return;
        const originalValue = comment.value;

        /** Issue: https://github.com/hosseinmd/prettier-plugin-jsdoc/issues/18 */
        comment.value = comment.value.replace(/^([*]+)/g, "*");
        // Create the full comment string with line ends normalized to \n
        // This means that all following code can assume \n and should only use
        // \n.
        const commentString = `/*${comment.value.replace(/\r\n?/g, "\n")}*/`;

        /**
         * Check if this comment block is a JSDoc. Based on:
         * https://github.com/jsdoc/jsdoc/blob/master/packages/jsdoc/plugins/commentsOnly.js
         */
        if (!/^\/\*\*[\s\S]+?\*\/$/.test(commentString)) return;

        const parsed = parse(commentString, {
          spacing: "preserve",
          tokenizers: [
            tagTokenizer(),
            (spec) => {
              if (isDefaultTag(spec.tag)) {
                return spec;
              }

              return typeTokenizer("preserve")(spec);
            },
            nameTokenizer(),
            descriptionTokenizer("preserve"),
          ],
        })[0];

        comment.value = "";

        if (!parsed) {
          // Error on commentParser
          return;
        }

        normalizeTags(parsed);
        convertCommentDescToDescTag(parsed);

        const commentContentPrintWidth = getIndentationWidth(
          comment,
          text,
          options,
        );

        let tags = parsed.tags
          // Prepare tags data
          .map(({ type, optional, ...rest }) => {
            if (type) {
              /**
               * Convert optional to standard
               * https://jsdoc.app/tags-type.html#:~:text=Optional%20parameter
               */
              type = type.replace(/[=]$/, () => {
                optional = true;
                return "";
              });

              type = convertToModernType(type);
            }

            return {
              ...rest,
              type,
              optional,
            } as Spec;
          });

        tags = await Promise.all(
          tags
            .map(assignOptionalAndDefaultToName)
            .map(async ({ type, ...rest }) => {
              if (type) {
                type = await formatType(type, {
                  ...options,
                  printWidth: commentContentPrintWidth,
                });
              }

              return {
                ...rest,
                type,
              } as Spec;
            }),
        );

        const filteredTags = tags.filter(({ description, tag }) => {
          if (!description && TAGS_DESCRIPTION_NEEDED.includes(tag)) {
            return false;
          }
          return true;
        });

        // Create final jsDoc string
        for (const [tagIndex, tagData] of filteredTags.entries()) {
          const formattedTag = await stringify(
            tagData,
            tagIndex,
            filteredTags,
            { ...options, printWidth: commentContentPrintWidth },
            0,
            0,
            0,
          );
          comment.value += formattedTag;
        }

        comment.value = comment.value.trimEnd();

        if (comment.value) {
          comment.value = addStarsToTheBeginningOfTheLines(
            originalValue,
            comment.value,
            options,
          );
        }

        if (eol === "cr") {
          comment.value = comment.value.replace(/\n/g, "\r");
        } else if (eol === "crlf") {
          comment.value = comment.value.replace(/\n/g, "\r\n");
        }
      }),
    );

    ast.comments = ast.comments.filter(
      (comment) => !(isBlockComment(comment) && !comment.value),
    );

    return ast;
  };

function isBlockComment(comment: PrettierComment): boolean {
  return comment.type === "CommentBlock" || comment.type === "Block";
}

function getIndentationWidth(
  comment: PrettierComment,
  text: string,
  options: AllOptions,
): number {
  const line = text.split(/\r\n?|\n/g)[comment.loc.start.line - 1];

  let spaces = 0;
  let tabs = 0;
  for (let i = comment.loc.start.column - 1; i >= 0; i--) {
    const c = line[i];
    if (c === " ") {
      spaces++;
    } else if (c === "\t") {
      tabs++;
    } else {
      break;
    }
  }

  return options.printWidth - (spaces + tabs * options.tabWidth) - " * ".length;
}

const TAGS_ORDER_LOWER = TAGS_ORDER.map((tagOrder) => tagOrder.toLowerCase());
/**
 * This will adjust the casing of tag titles, resolve synonyms, fix
 * incorrectly parsed tags, correct incorrectly assigned names and types, and
 * trim spaces.
 *
 * @param parsed
 */
function normalizeTags(parsed: Block): void {
  parsed.tags = parsed.tags.map(
    ({ tag, type, name, description, default: _default, ...rest }) => {
      tag = tag || "";
      type = type || "";
      name = name || "";
      description = description || "";
      _default = _default?.trim();

      /** When the space between tag and type is missing */
      const tagSticksToType = tag.indexOf("{");
      if (tagSticksToType !== -1 && tag[tag.length - 1] === "}") {
        type = tag.slice(tagSticksToType + 1, -1) + " " + type;
        tag = tag.slice(0, tagSticksToType);
      }

      tag = tag.trim();
      const lower = tag.toLowerCase();
      const tagIndex = TAGS_ORDER_LOWER.indexOf(lower);
      if (tagIndex >= 0) {
        tag = TAGS_ORDER[tagIndex];
      } else if (lower in TAGS_SYNONYMS) {
        // resolve synonyms
        tag = TAGS_SYNONYMS[lower as keyof typeof TAGS_SYNONYMS];
      }

      type = type.trim();
      name = name.trim();

      if (name && TAGS_NAMELESS.includes(tag)) {
        description = `${name} ${description}`;
        name = "";
      }
      if (type && TAGS_TYPELESS.includes(tag)) {
        description = `{${type}} ${description}`;
        type = "";
      }

      return {
        tag,
        type,
        name,
        description,
        default: _default,
        ...rest,
      };
    },
  );
}

/**
 * This will merge the comment description and all `@description` tags into one
 * `@description` tag.
 *
 * @param parsed
 */
function convertCommentDescToDescTag(parsed: Block): void {
  let description = parsed.description || "";
  parsed.description = "";

  parsed.tags = parsed.tags.filter(({ description: _description, tag }) => {
    if (tag.toLowerCase() === DESCRIPTION) {
      if (_description.trim()) {
        description += "\n\n" + _description;
      }
      return false;
    } else {
      return true;
    }
  });

  if (description) {
    parsed.tags.unshift({
      tag: DESCRIPTION,
      description,
      name: undefined as any,
      type: undefined as any,
      source: [],
      optional: false,
      problems: [],
    });
  }
}

/**
 * This will combine the `name`, `optional`, and `default` properties into name
 * setting the other two to `false` and `undefined` respectively.
 */
function assignOptionalAndDefaultToName({
  name,
  optional,
  default: default_,
  tag,
  type,
  source,
  description,
  ...rest
}: Spec): Spec {
  if (isDefaultTag(tag)) {
    const usefulSourceLine =
      source.find((x) => x.source.includes(`@${tag}`))?.source || "";

    const tagMatch = usefulSourceLine.match(
      /@default(Value)? (\[.*]|{.*}|\(.*\)|'.*'|".*"|`.*`| \w+)( ((?!\*\/).+))?/,
    );
    const tagValue = tagMatch?.[2] || "";
    const tagDescription = tagMatch?.[4] || "";

    if (tagMatch) {
      type = tagValue;
      name = "";
      description = tagDescription;
    }
  } else if (optional) {
    if (name) {
      // Figure out if tag type have default value
      if (default_) {
        name = `[${name}=${default_}]`;
      } else {
        name = `[${name}]`;
      }
    } else {
      type = `${type} | undefined`;
    }
  }

  return {
    ...rest,
    tag,
    name,
    description,
    optional,
    type,
    source,
    default: default_,
  };
}
