'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '@tauri-apps/api/core';

const openExternal = (url: string) => {
  invoke('open_external_url', { url }).catch((error) => console.error('Failed to open link:', error));
};

/** The release's CHANGELOG section from the feed. No raw HTML; links open in the browser. */
export function ReleaseNotes({ notes }: { notes: string }) {
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-af-border bg-af-panel-2/40 px-3 py-2 text-[13px] leading-relaxed text-af-text-2 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-af-text [&_h3]:mt-2 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-af-text [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <button
              type="button"
              className="text-af-accent hover:underline"
              onClick={() => href && /^https?:\/\//.test(href) && openExternal(href)}
            >
              {children}
            </button>
          ),
          img: () => null,
        }}
      >
        {notes}
      </ReactMarkdown>
    </div>
  );
}
