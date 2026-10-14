/**
 * The empty state: one card, the shape DSH's sidebar guide uses.
 *
 * The artwork is the reader's own — `GuideArtworkFiles` comes from the client primitives
 * this shell already ships — and the metrics are the guide entry's, so an empty window
 * looks like the product it came from.
 */
import React from 'react';
import { GuideArtworkFiles, ShortcutKeys } from '@deepseek-ai/dsh-client-ui-primitives';

/** The empty state's copy: opening a document is the only thing this shell does. */
const EMPTY_STATE = {
  title: '打开文档',
  description: '选择本地文件开始阅读',
  /** Rendered as keycaps by the reader's own `ShortcutKeys` primitive. */
  shortcut: ['Ctrl', 'O'],
};

export function EmptyState({ onPick }) {
  return (
    <div className="guide">
      <button type="button" className="guide__entry" onClick={() => void onPick()}>
        <span className="guide__icon" aria-hidden="true">
          <GuideArtworkFiles size={26} />
        </span>
        <span className="guide__text">
          <span className="guide__title">{EMPTY_STATE.title}</span>
          <span className="guide__description">{EMPTY_STATE.description}</span>
        </span>
        <span className="guide__shortcut">
          <ShortcutKeys keys={EMPTY_STATE.shortcut} />
        </span>
      </button>
      <p className="guide__hint">也可以把文件拖进窗口，或在资源管理器里双击文档。</p>
    </div>
  );
}
