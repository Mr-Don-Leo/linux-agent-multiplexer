import { Fragment, type ReactNode } from "react";
import { Lexer, type Token, type Tokens } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Markdown → React elements via marked's lexer. Rendering tokens as elements
 * (never HTML strings) keeps agent output XSS-safe with no sanitizer needed.
 */

function inline(tokens: Token[] | undefined, keyPrefix: string): ReactNode {
  if (!tokens) return null;
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case "strong":
        return <strong key={key}>{inline((token as Tokens.Strong).tokens, key)}</strong>;
      case "em":
        return <em key={key}>{inline((token as Tokens.Em).tokens, key)}</em>;
      case "del":
        return <del key={key}>{inline((token as Tokens.Del).tokens, key)}</del>;
      case "codespan":
        return <code key={key}>{(token as Tokens.Codespan).text}</code>;
      case "link": {
        const link = token as Tokens.Link;
        return (
          <a
            key={key}
            href={link.href}
            className="md-link"
            onClick={(e) => {
              e.preventDefault();
              if (/^https?:/.test(link.href)) openUrl(link.href).catch(() => {});
            }}
          >
            {inline(link.tokens, key)}
          </a>
        );
      }
      case "image":
        return <span key={key}>[{(token as Tokens.Image).text || "image"}]</span>;
      case "br":
        return <br key={key} />;
      case "escape":
        return <Fragment key={key}>{(token as Tokens.Escape).text}</Fragment>;
      case "text": {
        const text = token as Tokens.Text;
        return text.tokens ? (
          <Fragment key={key}>{inline(text.tokens, key)}</Fragment>
        ) : (
          <Fragment key={key}>{text.text}</Fragment>
        );
      }
      default:
        return <Fragment key={key}>{"raw" in token ? token.raw : ""}</Fragment>;
    }
  });
}

function block(tokens: Token[], keyPrefix: string): ReactNode {
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (token.type) {
      case "heading": {
        const heading = token as Tokens.Heading;
        const level = Math.min(4, Math.max(1, heading.depth));
        const Tag = `h${level}` as "h1";
        return (
          <Tag key={key} className="md-h">
            {inline(heading.tokens, key)}
          </Tag>
        );
      }
      case "paragraph":
        return <p key={key}>{inline((token as Tokens.Paragraph).tokens, key)}</p>;
      case "code": {
        const code = token as Tokens.Code;
        return (
          <div key={key} className="md-codeblock">
            {code.lang && <span className="md-lang">{code.lang}</span>}
            <pre className="md-code">{code.text}</pre>
          </div>
        );
      }
      case "blockquote":
        return (
          <blockquote key={key} className="md-quote">
            {block((token as Tokens.Blockquote).tokens, key)}
          </blockquote>
        );
      case "list": {
        const list = token as Tokens.List;
        const items = list.items.map((item, j) => (
          <li key={`${key}-${j}`}>{block(item.tokens, `${key}-${j}`)}</li>
        ));
        return list.ordered ? (
          <ol key={key} start={typeof list.start === "number" ? list.start : undefined}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "table": {
        const table = token as Tokens.Table;
        return (
          <table key={key} className="md-table">
            <thead>
              <tr>
                {table.header.map((cell, j) => (
                  <th key={j}>{inline(cell.tokens, `${key}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{inline(cell.tokens, `${key}-${r}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      case "hr":
        return <hr key={key} className="md-hr" />;
      case "space":
        return null;
      case "html":
        // Never inject raw HTML from agent output; show it as text.
        return <pre key={key} className="md-code">{(token as Tokens.HTML).raw}</pre>;
      case "text": {
        const text = token as Tokens.Text;
        return (
          <p key={key}>{text.tokens ? inline(text.tokens, key) : text.raw}</p>
        );
      }
      default:
        return <p key={key}>{"raw" in token ? token.raw : ""}</p>;
    }
  });
}

export default function Markdown({ text }: { text: string }) {
  const tokens = new Lexer({ gfm: true, breaks: true }).lex(text);
  return <div className="md">{block(tokens, "md")}</div>;
}
