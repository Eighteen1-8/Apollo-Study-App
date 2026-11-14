/* Links from content shown in a subject back into it, for components deep inside panes that other code renders
   (Apollo's comments inside the note editor, a marking's earlier versions): open a citation's file at its page, or
   open generated content. SubjectView provides them; outside a subject they're absent and the links stay plain text. */
import { createContext, useContext } from 'react';

export interface SubjectLinks {
  /** Open `file` at the slide/page `label` names (SubjectView.openCitation). */
  cite?: (file: string, label: string) => void;
  /** Open generated content (a marking's earlier version, a new version being made). */
  openArtifact?: (id: number) => void;
}

export const SubjectLinksContext = createContext<SubjectLinks>({});
export const useSubjectLinks = () => useContext(SubjectLinksContext);
