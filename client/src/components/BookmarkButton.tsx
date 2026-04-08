/**
 * Bookmark button — copies a shareable URL capturing current view state
 * to the clipboard.
 */

import React, {useState, useCallback} from 'react';
import {Bookmark, Check} from 'lucide-react';
import {useBookmark} from '../hooks/useBookmark';

export const BookmarkButton: React.FC = () => {
  const {getBookmarkUrl} = useBookmark();
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(async () => {
    const url = getBookmarkUrl();
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [getBookmarkUrl]);

  return (
    <button
      onClick={handleClick}
      className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
      title="Copy bookmark URL to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Bookmark className="h-3.5 w-3.5" />
      )}
      <span>{copied ? 'Copied!' : 'Bookmark'}</span>
    </button>
  );
};
