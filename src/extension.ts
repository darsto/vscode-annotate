import * as vscode from 'vscode';
import { simple_eval } from './simple_eval';

// A single parsed annotation
// > @annotate [<start> - <end>] [<color>] <text>
interface Annotation {
	start: number;
	end: number;
	color?: string;
	text?: string;
};

// Configuration for all subsequent Annotations
// Particular fields can be set in the document:
// > @annotate-cfg [clamp = [7, 54]]
// > @annotate-cfg [rangeFn = { start = 8 + start * 3 - 1; end = 8 + end * 3 - 2 }]
interface AnnotationCfg {
	clamp?: [number, number];
	rangeFn?: string,
}

// Global storage for all vscode.TextEditorDecorationType, mapped by a short color
// string. This is shared across all editors, so we can nuke all decorations when
// deactivating the extension.
const decorationTypeByColor = new Map<string, vscode.TextEditorDecorationType>();
type DecorationsMap = Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>;

// For early optimization, only parse the regex on lines starting with those
// characters (first non whitespace character)
const annotationCommentCharacters = ['/', '#', '*', '@', '>'];
const annotationRegEx = /\@annotate\s*\[([0-9]+)\s*\-\s*([0-9]+)\]\s*(?:\[([#a-zA-Z0-9]+)\])?\s*(.*)/;
const annotationCfgPrefix = '@annotate-cfg';
const annotationCfgOptRegEx = /\[\s*(.*?)\s*=\s*(.*)\s*\]/g;

function createDecoration(color: string): vscode.TextEditorDecorationType {
	let colorVal: string | vscode.ThemeColor = color;
	if (color.startsWith("default")) {
		let idx = parseInt(color.substring("default".length)) || 0;
		colorVal = { id: "annotate.defaultColor" + idx };
	}
	return vscode.window.createTextEditorDecorationType({
		borderWidth: '1px',
		borderStyle: 'solid',
		light: { backgroundColor: colorVal },
		dark: { backgroundColor: colorVal },
		borderColor: '#ffffff50',
	});
}

function addAnnotations(decorationsMap: DecorationsMap, linePos: vscode.Position, annotations: Annotation[], cfg: AnnotationCfg) {
	let defColorIdx = 0;
	for (let anno of annotations) {
		try {
			if (cfg.rangeFn) {
				let ctx = simple_eval(cfg.rangeFn, { start: anno.start, end: anno.end });
				[anno.start, anno.end] = [ctx.start, ctx.end];
			}
			if (cfg.clamp) {
				anno.start = Math.max(anno.start, cfg.clamp[0]);
				anno.end = Math.min(anno.end, cfg.clamp[1]);
			}
			if (anno.end <= anno.start) {
				// just skip the annotation
				continue;
			}
		} catch (e) {
			// log the error by showing it in place of the original annotation
			const err = e as Error;
			anno.color = 'red';
			anno.text = 'Error: ' + err.message;
			[anno.start, anno.end] = [0, 9999];
		}

		const startPos = linePos.translate(0, anno.start);
		const endPos = linePos.translate(0, anno.end);
		let decoration: vscode.DecorationOptions = { range: new vscode.Range(startPos, endPos) };
		if (anno.text) {
			const markdown = new vscode.MarkdownString(anno.text, true);
			markdown.isTrusted = true;
			decoration.hoverMessage = markdown;
		}
		let color = anno.color || ('default' + defColorIdx);

		let decorationType = decorationTypeByColor.get(color);
		if (!decorationType) {
			decorationType = createDecoration(color);
			decorationTypeByColor.set(color, decorationType);
		}
		let decorationsArr = decorationsMap.get(decorationType)!;
		if (!decorationsArr) {
			decorationsArr = [];
			decorationsMap.set(decorationType, decorationsArr);
		}
		decorationsArr.push(decoration);
		defColorIdx = ((defColorIdx + 1) % 8);
	}
}

function parseDocument(editor: vscode.TextEditor, currentCfg: AnnotationCfg, startLine: number, endLine: number, addAnnotationsFn: Function) {
	let pendingAnnotations: Annotation[] = [];
	let lastNonCommentLinePos: vscode.Position | undefined;

	for (let i = startLine; i < endLine; i++) {
		const line = editor.document.lineAt(i);
		const firstChar = line.text[line.firstNonWhitespaceCharacterIndex];
		if (annotationCommentCharacters.includes(firstChar)) {
			const re = new RegExp(annotationRegEx, annotationRegEx.flags);
			const match = re.exec(line.text);
			if (match?.length && match?.length > 3) {
				if (match.length >= 3) {
					pendingAnnotations.push({ start: parseInt(match[1]), end: parseInt(match[2]), color: match[3], text: match[4] });
				}
			} else {
				let matchidx = line.text.indexOf(annotationCfgPrefix);
				if (matchidx >= 0) {
					let opts_string = line.text.substring(matchidx + annotationCfgPrefix.length);
					const opt_re = new RegExp(annotationCfgOptRegEx, annotationCfgOptRegEx.flags);

					let match;
					while (match = opt_re.exec(opts_string)) {
						let key = match[1];
						let value = match[2];

						try {
							switch (key) {
								case "rangeFn": {
									const rangeFnRegEx = /{(.*)}/;
									let matches = rangeFnRegEx.exec(value);
									if (matches) {
										currentCfg.rangeFn = matches[1];
									}
									break;
								}
								case "clamp": {
									const clampRegEx = /\[([0-9]+)\s*[-,]\s*([0-9]+)\]/;
									let matches = clampRegEx.exec(value);
									if (matches) {
										currentCfg.clamp = [parseInt(matches[1]), parseInt(matches[2])];
									}
									break;
								}
								default:
									pendingAnnotations.push({ start: 0, end: 9999, color: "red", text: "Unknown field: " + key });
									break;
							}

						} catch (e) {
							let err = e as Error;
							pendingAnnotations.push({ start: 0, end: 9999, color: "red", text: "Error: " + err });
						}
					}
				}
			}
		} else {
			if (lastNonCommentLinePos && pendingAnnotations.length > 0) {
				addAnnotationsFn(lastNonCommentLinePos, pendingAnnotations, currentCfg);
				pendingAnnotations.length = 0;
			}

			lastNonCommentLinePos = line.range.start;
		}
	}

	if (lastNonCommentLinePos && pendingAnnotations.length > 0) {
		addAnnotationsFn(lastNonCommentLinePos, pendingAnnotations, currentCfg);
	}
}

export function activate(context: vscode.ExtensionContext) {
	let activeEditor = vscode.window.activeTextEditor;
	// per-editor (weak!) map of decorations. This could be in the global scope,
	// but when we get de-activated we want to drop all of this memory even if the
	// corresponding editors still exist.
	const decorationsMapByEditor = new WeakMap<vscode.TextEditor, DecorationsMap>();

	// The automatic annotate command
	let disposable = vscode.commands.registerCommand('annotate.annotate', () => {
		if (!activeEditor) {
			vscode.window.showWarningMessage('No active window');
			return;
		}

		const workbenchConfig = vscode.workspace.getConfiguration("annotate");
		const defaultCommentPrefix = workbenchConfig.get<string>("defaultCommentPrefix")!;
		const selection = activeEditor.selection;
		const selectionLine = selection.start.line;

		let snippet;
		if (selection?.isEmpty) {
			snippet = new vscode.SnippetString(`${defaultCommentPrefix}@annotate [$0]\n`);
		} else {
			let snippetStartCharacter = selection.start.character;
			let snippetEndCharacter = selection.end.character;
			if (selection.start.line !== selection.end.line) {
				// Multi line snippets are currently not supported, just use the rest of first line
				snippetEndCharacter = activeEditor.document.lineAt(selectionLine).text.length;
			}

			// get the cfg at that particular line
			let cfg: AnnotationCfg = {};
			parseDocument(activeEditor, cfg, 0, selectionLine, () => { });

			// get matching column numbers for the current cfg
			// since it's not a big deal, just find a proper value by brute force
			// also, assume there are less columns than characters
			let startColumnIdx = 0;
			for (; startColumnIdx < snippetStartCharacter; startColumnIdx++) {
				if (cfg.rangeFn) {
					let ctx = simple_eval(cfg.rangeFn, { start: startColumnIdx, end: startColumnIdx });
					if (ctx.start >= snippetStartCharacter) {
						break;
					}

				} else {
					startColumnIdx = snippetStartCharacter;
					break;
				}
			}
			let endColumnIdx = 0;
			for (; endColumnIdx <= snippetEndCharacter; endColumnIdx++) {
				if (cfg.rangeFn) {
					let ctx = simple_eval(cfg.rangeFn, { start: endColumnIdx, end: endColumnIdx });
					if (ctx.end > snippetEndCharacter) {
						endColumnIdx -= 1;
						break;
					}

				} else {
					endColumnIdx = snippetEndCharacter;
					break;
				}
			}

			snippet = new vscode.SnippetString(`${defaultCommentPrefix}@annotate [${startColumnIdx}-${endColumnIdx}] $0\n`);
		}

		// insert the annotation after any existing annotations to prevent changing their colors
		let snippetLine = selectionLine + 1;
		for (let i = snippetLine; i < activeEditor.document.lineCount; i++) {
			const line = activeEditor.document.lineAt(i);
			const firstChar = line.text[line.firstNonWhitespaceCharacterIndex];

			if (annotationCommentCharacters.includes(firstChar) && annotationRegEx.test(line.text)) {
				snippetLine++;
			} else {
				break;
			}
		}

		activeEditor.insertSnippet(snippet, new vscode.Position(snippetLine, 0));
		triggerUpdateDecorations(false);
	});
	context.subscriptions.push(disposable);

	// Folds for all annotations
	disposable = vscode.languages.registerFoldingRangeProvider('*', {
		provideFoldingRanges(document, context, token) {
			let annotatedLineNo = undefined;
			let folds = [];

			for (let i = 0; i < document.lineCount; i++) {
				const line = document.lineAt(i);
				const firstChar = line.text[line.firstNonWhitespaceCharacterIndex];

				if (annotationCommentCharacters.includes(firstChar) && annotationRegEx.test(line.text)) {
					if (annotatedLineNo === undefined) {
						annotatedLineNo = i === 0 ? 0 : i - 1;
					}
				} else if (annotatedLineNo !== undefined) {
					folds.push(new vscode.FoldingRange(annotatedLineNo, i - 1, vscode.FoldingRangeKind.Comment));
					annotatedLineNo = undefined;
				}
			}
			if (annotatedLineNo !== undefined) {
				folds.push(new vscode.FoldingRange(annotatedLineNo, document.lineCount - 1, vscode.FoldingRangeKind.Comment));
			}

			return folds;
		}
	});
	context.subscriptions.push(disposable);

	// The main annotation parsing
	function updateDecorations() {
		if (!activeEditor) {
			return;
		}

		let decorationsMap = decorationsMapByEditor.get(activeEditor);
		if (!decorationsMap) {
			decorationsMap = new Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>();
			decorationsMapByEditor.set(activeEditor, decorationsMap);
		}
		let currentCfg: AnnotationCfg = {};

		let addAnnotationsFn = (linePos: vscode.Position, annotations: Annotation[], cfg: AnnotationCfg) => {
			addAnnotations(decorationsMap!, linePos, annotations, cfg);
		};

		parseDocument(activeEditor, currentCfg, 0, activeEditor.document.lineCount, addAnnotationsFn);

		for (const [type, decorations] of decorationsMap!) {
			activeEditor.setDecorations(type, decorations);

			// prepare for the next iterations
			if (decorations.length > 0) {
				// make sure this decoration is cleared on next run
				decorationsMap!.set(type, []);
			} else {
				// remove from the global map so we're not leaking memory
				decorationsMap!.delete(type);
				for (const [icolor, itype] of decorationTypeByColor) {
					if (itype === type) {
						decorationTypeByColor.delete(icolor);
					}
				}
			}
		}
	}

	// the remaining code is copied from
	// https://github.com/microsoft/vscode-extension-samples/blob/main/decorator-sample/src/extension.ts

	let timeout: NodeJS.Timeout | undefined = undefined;
	function triggerUpdateDecorations(throttle = false) {
		if (timeout) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		if (throttle) {
			timeout = setTimeout(updateDecorations, 500);
		} else {
			updateDecorations();
		}
	}

	if (activeEditor) {
		triggerUpdateDecorations();
	}

	vscode.window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (editor) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	vscode.workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document) {
			triggerUpdateDecorations(true);
		}
	}, null, context.subscriptions);
}

export function deactivate() {
	// remove all decorations across all editors
	for (const type of decorationTypeByColor.values()) {
		type.dispose();
	}

	decorationTypeByColor.clear();
}
