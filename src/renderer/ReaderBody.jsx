/**
 * One tab's reader body, mounted through the reader's own slot.
 *
 * No reader component is imported here: a body is resolved from the reader's own
 * registration in the seat the contract names. A crash inside that third-party code must
 * not take the shell down, so the occurrence sits behind an error boundary that reports
 * what failed.
 */
import React, { useMemo, useState } from 'react';
import { useShell } from './dsh/runtime-context.js';
import { renderSlotOccurrence } from './dsh/slot-service.js';
import { READER_TAB_ID, SLOTS } from './dsh/contract.js';

export function ReaderBody({ runtime }) {
  const [error, setError] = useState(undefined);
  const { tabInfo } = useShell();
  // The occurrence is recomputed whenever the tab's navigation advances: the reader's own
  // effect keys off `navigation.revision`, so a staler props object would leave a
  // jump-to-line request unheard.
  const revision = tabInfo?.tab?.navigation?.revision;
  const occurrence = useMemo(() => {
    try {
      return renderSlotOccurrence(runtime.slotService, SLOTS.documentTab, {}, { entryKey: READER_TAB_ID, hookContext: tabInfo });
    } catch (problem) {
      console.error('[shell] slot dispatch failed', problem);
      return undefined;
    }
  }, [runtime, tabInfo, revision]);

  if (error !== undefined) {
    return (
      <div className="body__error">
        <p>这个文件无法显示：</p>
        <pre>{error}</pre>
      </div>
    );
  }
  if (occurrence === undefined) {
    return <div className="body__error">阅读器没有注册任何文档视图。</div>;
  }
  const { Component, props } = occurrence;
  return (
    <ReaderErrorBoundary onError={setError}>
      <Component {...props} />
    </ReaderErrorBoundary>
  );
}

/** React error boundary: the reader's bodies are third-party code from the shell's view. */
class ReaderErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    this.props.onError?.(String(error?.stack ?? error?.message ?? error));
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
