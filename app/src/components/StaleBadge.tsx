import { useOverlay } from './overlay';
import { useAdvanced } from '../theme';

/**
 * Small warning mark for files embedded with a different embedding model than the one in Settings: search can't use
 * them until they're re-ingested. Clicking offers to re-ingest them. It disappears once they're re-ingested, or when
 * the model is changed back.
 */
export default function StaleBadge({ count, where, onReingest, className }: {
  count: number | undefined; where: string; onReingest: () => Promise<unknown>; className?: string;
}) {
  const ov = useOverlay();
  const advanced = useAdvanced();
  if (!count) return null;
  const files = `${count} file${count === 1 ? '' : 's'}`;
  return (
    <span role="button" tabIndex={0} className={`stale-badge${advanced ? '' : ' stale-badge-text'} ${className ?? ''}`}
      title={advanced ? `${files} in ${where} need re-ingesting (the embedding model changed). Click to re-ingest.`
        : `${files} in ${where} can't be searched until they're updated (the search model was changed). Click to update.`}
      onClick={async (e) => {
        e.stopPropagation();
        if (await ov.confirm(advanced ? {
          title: `Re-ingest ${files}?`, confirmText: 'Re-ingest',
          body: `${files} in ${where} were embedded with a different embedding model, so search can't use them. Re-ingesting re-embeds them with the current model (vision notes are kept). Large files can take a while.`,
        } : {
          title: `Update ${files}?`, confirmText: 'Update',
          body: `The search model was changed, so Apollo can't search ${files} in ${where} until they're processed again. Notes about their pictures are kept. Large files can take a while.`,
        })) await onReingest();
      }}>{advanced || className === 'on-tile' ? '!' : 'Needs update'}</span>
  );
}
