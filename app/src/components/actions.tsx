import { api, MaintScope, Subject, Topic } from '../api';
import type { Route } from '../App';
import { useOverlay } from './overlay';

const COLORS = ['#7c8cff', '#4fd1c5', '#f6ad55', '#f687b3', '#68d391', '#b794f4', '#63b3ed', '#fc8181'];

/** Create / rename / delete for subjects and topics, shared by the sidebar and the subject page. */
export function useLibraryActions(subjects: Subject[], go: (r: Route) => void, onChange: () => void) {
  const ov = useOverlay();
  return {
    async newSubject() {
      const name = await ov.prompt({ title: 'New subject', placeholder: 'e.g. Physics', confirmText: 'Create' });
      if (!name) return;
      const s = await api.createSubject(name, COLORS[subjects.length % COLORS.length]);
      onChange();
      go({ name: 'subject', id: s.id });
    },
    async renameSubject(s: Subject) {
      const name = await ov.prompt({ title: 'Rename subject', initial: s.name });
      if (name) { await api.renameSubject(s.id, name); onChange(); }
    },
    async deleteSubject(s: Subject) {
      const ok = await ov.confirm({
        title: `Delete ${s.name}?`, danger: true, confirmText: 'Delete subject',
        body: 'All its topics, uploaded files, chats and generated content are removed from the app.',
      });
      if (ok) { await api.deleteSubject(s.id); onChange(); go({ name: 'home' }); }
    },
    async newTopic(s: Subject) {
      const name = await ov.prompt({ title: `New topic in ${s.name}`, placeholder: 'e.g. Motion', confirmText: 'Create' });
      if (!name) return;
      await api.createTopic(s.id, name);
      onChange();
      go({ name: 'subject', id: s.id });
    },
    async renameTopic(t: Topic) {
      const name = await ov.prompt({ title: 'Rename topic', initial: t.name });
      if (name) { await api.renameTopic(t.id, name); onChange(); }
    },
    /** Flag vision notes that are malformed, cut off or (by Apollo's review against the image) wrong. */
    async checkVision(scope: MaintScope, name: string, subjectId: number) {
      const r = await api.visionScan(scope);
      const open = await ov.confirm({
        title: `Checking vision notes: ${name}`, confirmText: 'Open Maintenance',
        body: <>
          {r.rule_flags ? `${r.rule_flags} problem${r.rule_flags === 1 ? '' : 's'} found by the quick checks.` : 'The quick checks found no problems.'}{' '}
          {r.units ? `Apollo is now comparing ${r.units} page${r.units === 1 ? '' : 's'} with ${r.units === 1 ? 'its image' : 'their images'} in the background (see the jobs list); anything it flags shows up in Settings → Maintenance with the reason.`
            : 'Every page has already been reviewed by Apollo.'}
        </>,
      });
      if (open) go({ name: 'settings', tab: 'maintenance', subjectId });
    },
    async deleteTopic(t: Topic) {
      const ok = await ov.confirm({
        title: `Delete topic ${t.name}?`, danger: true, confirmText: 'Delete topic',
        body: 'Its uploaded files, extracted text and embeddings are removed. Generated content stays.',
      });
      if (ok) { await api.deleteTopic(t.id); onChange(); }
    },
  };
}
