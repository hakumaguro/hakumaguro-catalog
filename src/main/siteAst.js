// AST access to hakumaguroDev's content files, via ts-morph.
// Lightweight: parses individual files directly, does NOT load the full
// Next.js tsconfig program (that would be slow and isn't needed for editing —
// correctness is verified separately by running the repo's own `tsc --noEmit`,
// see writer.js).

const fs = require("fs");
const path = require("path");
const { Project, SyntaxKind, IndentationText, NewLineKind } = require("ts-morph");

function siteTsPath(repoPath) {
  return path.join(repoPath, "src", "lib", "site.ts");
}
function pageTsxPath(repoPath) {
  return path.join(repoPath, "src", "app", "page.tsx");
}
function logoMarkTsxPath(repoPath) {
  return path.join(repoPath, "src", "ds", "LogoMark.tsx");
}

/**
 * Sniffs the target file's line-ending convention before creating the
 * Project — Windows checkouts of this repo are CRLF on disk (git core.autocrlf)
 * while ts-morph defaults new text to LF, which otherwise produces a
 * mixed-EOL file on save (verified empirically: `git status` kept flagging
 * a content-identical file as modified until this was fixed).
 */
function detectNewLineKind(filePath) {
  if (!fs.existsSync(filePath)) return NewLineKind.LineFeed;
  const sample = fs.readFileSync(filePath, "utf8").slice(0, 4096);
  return sample.includes("\r\n") ? NewLineKind.CarriageReturnLineFeed : NewLineKind.LineFeed;
}

function newProject(sniffPath) {
  // hakumaguroDev's site.ts/page.tsx use 2-space indentation — match it so
  // ts-morph's auto-indent on insert doesn't introduce a mismatched level
  // (verified empirically: ts-morph adds one indentationText level to every
  // line of text passed to addElement()).
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
      newLineKind: sniffPath ? detectNewLineKind(sniffPath) : NewLineKind.LineFeed,
    },
  });
}

function literalToPlain(node) {
  if (!node) return undefined;
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getLiteralText();
  }
  if (kind === SyntaxKind.NumericLiteral) {
    return node.getLiteralValue();
  }
  if (kind === SyntaxKind.AsExpression) {
    return literalToPlain(node.getExpression());
  }
  if (kind === SyntaxKind.ParenthesizedExpression) {
    return literalToPlain(node.getExpression());
  }
  // fallback: raw text, quotes stripped if present
  const text = node.getText();
  return text.replace(/^["']|["']$/g, "");
}

function objectLiteralToPlain(objLiteral) {
  const out = {};
  for (const prop of objLiteral.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const name = prop.getName();
    out[name] = literalToPlain(prop.getInitializer());
  }
  return out;
}

/**
 * Reads `artPieces`, `vrClips`, and `lifeSource` out of site.ts as plain
 * JS arrays of plain objects. `lifeSource` is NOT exported (only the derived
 * `lifeItems` is) — use getVariableDeclaration, not getExportedDeclarations.
 */
function readArrays(repoPath) {
  const project = newProject();
  const sf = project.addSourceFileAtPath(siteTsPath(repoPath));

  const read = (varName) => {
    const decl = sf.getVariableDeclaration(varName);
    if (!decl) throw new Error(`site.ts: variable "${varName}" not found`);
    const init = decl.getInitializerIfKind(SyntaxKind.ArrayLiteralExpression);
    if (!init) throw new Error(`site.ts: "${varName}" is not an array literal`);
    return init.getElements().map((el) => {
      if (el.getKind() !== SyntaxKind.ObjectLiteralExpression) {
        // e.g. artPieces has one element with `empty: true` in the mockup demo,
        // but real site.ts elements are always object literals.
        return { __raw: el.getText() };
      }
      return objectLiteralToPlain(el);
    });
  };

  return {
    artPieces: read("artPieces"),
    vrClips: read("vrClips"),
    lifeSource: read("lifeSource"),
  };
}

/** Reads the 3 hardcoded <Image> slots in page.tsx: src, alt, and the block prop that echoes alt. */
function readFixedPageSlots(repoPath) {
  const project = newProject();
  const sf = project.addSourceFileAtPath(pageTsxPath(repoPath));

  const images = sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement);
  const slots = [];
  for (const img of images) {
    if (img.getTagNameNode().getText() !== "Image") continue;
    const attrs = {};
    for (const attr of img.getAttributes()) {
      if (attr.getKind() !== SyntaxKind.JsxAttribute) continue;
      const name = attr.getNameNode().getText();
      const init = attr.getInitializer();
      if (!init) continue;
      if (init.getKind() === SyntaxKind.StringLiteral) {
        attrs[name] = init.getLiteralText();
      } else if (init.getKind() === SyntaxKind.JsxExpression) {
        const expr = init.getExpression();
        attrs[name] = expr ? literalToPlain(expr) : undefined;
      }
    }
    // Only literal string srcs are real fixed slots — `withMedia()`'s
    // `<Image src={image} alt={rest.mediaLabel} />` is the gallery-tile
    // template, not one of the 3 hardcoded slots, and its src/alt are JSX
    // expressions (identifiers), not string literals.
    if (attrs.src && attrs.src.startsWith("/")) slots.push({ src: attrs.src, alt: attrs.alt });
  }
  return slots;
}

module.exports = {
  siteTsPath,
  pageTsxPath,
  logoMarkTsxPath,
  newProject,
  literalToPlain,
  objectLiteralToPlain,
  readArrays,
  readFixedPageSlots,
};
