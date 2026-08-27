import { useEffect, useRef, useState } from 'react';
import type { SpanRow } from '../types';

/**
 * Page image with bounding-box overlay (P11).
 *
 * Spans are stored normalized 0..1 (P7), so the overlay is a percentage-positioned layer
 * over the image and stays correct at any zoom or DPI without recomputing anything.
 */
interface Props {
  pageId: string;
  spans: SpanRow[];
  highlightedSpanIds: string[];
  onSpanClick?: (span: SpanRow) => void;
}

export function PageOverlay({ pageId, spans, highlightedSpanIds, onSpanClick }: Props) {
  const [zoom, setZoom] = useState(1);
  const [showAllSpans, setShowAllSpans] = useState(false);
  const [purged, setPurged] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlighted = new Set(highlightedSpanIds);

  useEffect(() => {
    setPurged(false);
  }, [pageId]);

  // Scroll the first highlighted span into view when the selected field changes.
  useEffect(() => {
    if (!highlightedSpanIds.length || !containerRef.current) return;
    const el = containerRef.current.querySelector('[data-highlighted="true"]');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlightedSpanIds]);

  return (
    <div className="overlay-pane">
      <div className="overlay-toolbar">
        <button onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}>−</button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(4, z + 0.25))}>+</button>
        <button onClick={() => setZoom(1)}>Fit</button>
        <label className="toggle">
          <input type="checkbox" checked={showAllSpans} onChange={(e) => setShowAllSpans(e.target.checked)} />
          Show all spans
        </label>
      </div>

      <div className="overlay-scroll" ref={containerRef}>
        {purged ? (
          <div className="purged-notice">
            <strong>Page image purged.</strong>
            <p>
              This raster passed its retention window and was disposed of on schedule. The
              extracted values and their span coordinates remain.
            </p>
          </div>
        ) : (
          <div className="page-frame" style={{ width: `${zoom * 100}%` }}>
            <img
              src={`/api/pages/${pageId}/image`}
              alt="Source page"
              onError={() => setPurged(true)}
              draggable={false}
            />
            {spans.map((span) => {
              const isHit = highlighted.has(span.id);
              if (!isHit && !showAllSpans) return null;
              return (
                <button
                  key={span.id}
                  type="button"
                  className={isHit ? 'span-box hit' : 'span-box'}
                  data-highlighted={isHit ? 'true' : 'false'}
                  title={span.text}
                  onClick={() => onSpanClick?.(span)}
                  style={{
                    left: `${span.x0 * 100}%`,
                    top: `${span.y0 * 100}%`,
                    width: `${(span.x1 - span.x0) * 100}%`,
                    height: `${(span.y1 - span.y0) * 100}%`,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
