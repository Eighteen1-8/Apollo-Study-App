import { useOverlay } from './overlay';

/**
 * Small warning mark for files embedded with a different embedding model than the one in Settings: search can't use
 * them until they're re-ingested. Clicking offers to re-ingest them. It disappears once they're re-ingested, or when
 * the model is changed back.
 */
export default function StaleBadge({ count, where, onReingest, className }: {
  count: number | undefined; where: string; onReingest: () => Promise<unknown>; className?: string;
}) {
  const ov = useOverlay();
  if (!count) return null;
  const files = `${count} file${count === 1 ? '' : 's'}`;
  return (
    <span role="button" tabIndex={0} className={`stale-badge ${className ?? ''}`} title={`${files} in ${where} need re-ingesting (the embedding model changed). Click to re-ingest.`}
      onClick={async (e) => {
        e.stopPropagation();
        if (await ov.confirm({
          title: `Re-ingest ${files}?`, confirmText: 'Re-ingest',
          body: `${files} in ${where} were embedded with a different embedding model, so search can't use them. Re-ingesting re-embeds them with the current model (vision notes are kept). Large files can take a while.`,
        })) await onReingest();
      }}>!</span>
  );
}
