import type { Context } from './Context';

import Builder from './Builder';
import { CompilerOptions, Grammar as GrammarFile, EmitFormat } from 'grammarkdown';

const endTagRe = /<\/?(emu-\w+|h?\d|p|ul|table|pre|code)\b[^>]*>/i;
const globalEndTagRe = /<\/?(emu-\w+|h?\d|p|ul|table|pre|code)\b[^>]*>/gi;

/*@internal*/
export default class Grammar extends Builder {
  static async enter({ spec, node }: Context) {
    if ('grammarkdownOut' in node) {
      // i.e., we already parsed this during the lint phase
      // @ts-ignore
      node.innerHTML = node.grammarkdownOut;
      return;
    }

    // fetch the original source text and source DOM for the node.
    // walk up the current DOM as this may come from an import.
    const location = spec.locate(node);
    let content: string;
    let possiblyMalformed = true;
    // If the source text is available, we should use it since `innerHTML` serializes the
    // DOM tree beneath the node. This can result in odd behavior when the syntax is malformed
    // in a way that parse5 does not understand, but grammarkdown could possibly recover.
    if (location) {
      if (location.startTag && location.endTag) {
        // the parser was able to find a matching end tag.
        const start = location.startTag.endOffset as number;
        const end = location.endTag.startOffset as number;
        content = location.source.slice(start, end);
      } else {
        // TODO this is not reached
        // the parser was *not* able to find a matching end tag. Try to recover by finding a
        // possible end tag, otherwise read the rest of the source text.
        const start = (globalEndTagRe.lastIndex = location.endOffset as number);
        const match = globalEndTagRe.exec(location.source);
        const end = match ? match.index : location.source.length;
        content = location.source.slice(start, end);

        // since we already tested for an end tag, no need to test again later.
        possiblyMalformed = false;
        globalEndTagRe.lastIndex = 0;
      }
    } else {
      // no source text, so read innerHTML as a fallback.
      content = node.innerHTML.replace(/&gt;/g, '>');
    }

    if (possiblyMalformed) {
      // check for a possible end-tag in the content. For now we only check for a few possible
      // recovery cases, namely emu-* tags, and a few block-level elements.
      const match = endTagRe.exec(content);
      if (match) {
        content = content.slice(0, match.index);
      }
    }

    const options: CompilerOptions = {
      format: EmitFormat.ecmarkup,
      noChecks: true,
    };

    node.innerHTML = await GrammarFile.convert(
      content,
      options,
      /*hostFallback*/ undefined,
      spec.cancellationToken
    );
  }

  static elements = ['EMU-GRAMMAR'];
}
