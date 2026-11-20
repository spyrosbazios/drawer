import { cpp } from "@codemirror/lang-cpp";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

export type EditorLanguage = "scad" | "markdown" | "text";

/** Colours are the app's CSS variables, so the editor follows the theme with no values of its own. */
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--app-card)", color: "var(--app-fg)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--app-brand)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--app-brand)" },
  ".cm-gutters": { backgroundColor: "var(--app-card)", color: "var(--app-faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--app-raised) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--app-raised) 55%, transparent)", color: "var(--app-fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--app-brand) 28%, transparent)",
  },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--app-brand) 25%, transparent)", outline: "none" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--app-cat2)" },
  { tag: [t.string, t.special(t.string)], color: "var(--app-cat3)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--app-cat4)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--app-faint)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: "var(--app-cat1)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--app-dim)" },
  { tag: [t.heading, t.strong], fontWeight: "600", color: "var(--app-fg)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--app-brand)" },
  { tag: [t.monospace, t.processingInstruction], color: "var(--app-cat5)" },
  { tag: t.quote, color: "var(--app-dim)" },
]);

function languageOf(language: EditorLanguage): Extension {
  switch (language) {
    case "scad":
      return cpp(); // OpenSCAD is C-like: the C++ grammar highlights its keywords, numbers, strings and comments well enough.
    case "markdown":
      return markdown({ base: markdownLanguage });
    case "text":
      return [];
  }
}

const external = Annotation.define<boolean>();

interface CodeEditorProps {
  value: string;
  language: EditorLanguage;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  /** Soft-wrap long lines (prose). */
  wrap?: boolean;
}

export default function CodeEditor({ value, language, readOnly = false, onChange, onSave, wrap = false }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());
  const accessCompartment = useRef(new Compartment());
  // Callbacks and the first value are read through refs so the editor is created exactly once.
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initial = useRef({ value, language, readOnly, wrap });
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const first = initial.current;
    const v = new EditorView({
      parent,
      state: EditorState.create({
        doc: first.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(highlight),
          theme,
          first.wrap ? EditorView.lineWrapping : [],
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          langCompartment.current.of(languageOf(first.language)),
          accessCompartment.current.of([EditorState.readOnly.of(first.readOnly), EditorView.editable.of(!first.readOnly)]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(external))) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value }, annotations: external.of(true) });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: langCompartment.current.reconfigure(languageOf(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: accessCompartment.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
