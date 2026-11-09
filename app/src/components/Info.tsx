/* A small ⓘ "What's this?" marker beside an idea that needs one sentence of explanation (hover or focus shows it). */
import Icon from './Icon';

export default function Info({ text }: { text: string }) {
  return (
    <span className="info-mark" role="img" tabIndex={0} aria-label={`What's this? ${text}`} data-tip={text}
      onClick={(e) => e.stopPropagation()}>
      <Icon name="help" size={13} />
    </span>
  );
}
