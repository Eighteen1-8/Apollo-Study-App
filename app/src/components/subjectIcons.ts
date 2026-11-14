/* The art a subject can wear (its tile in the side bar, home page and file panel): five for each of twenty subjects,
   Microsoft Fluent Emoji (animated set, MIT), bundled by app/scripts/fetch_subject_art.py as a still first frame
   (`<key>.webp`) and an animation played on hover (`<key>.anim.webp`). Stored by key in `subjects.icon_name`;
   older Lucide keys map to the nearest art, and an unknown key falls back to the letters. */

const stills = import.meta.glob<string>('../assets/subject-art/*.webp', { eager: true, query: '?url', import: 'default' });

const url = (key: string, anim: boolean): string | null => stills[`../assets/subject-art/${key}${anim ? '.anim' : ''}.webp`] ?? null;

export interface SubjectArt { key: string; label: string; still: string; anim: string | null }

const GROUPS: [subject: string, words: string, names: string[]][] = [
  ['Mathematics', 'maths math calculus algebra statistics geometry', ['Nerd face', 'Hundred points', 'Thinking face', 'Stopwatch', 'Timer clock']],
  ['English', 'english writing grammar essay', ['Writing hand', 'Love letter', 'Owl', 'Mouth', 'Bust in silhouette']],
  ['Literature', 'literature novel poetry fiction classics', ['Dragon', 'Unicorn', 'Phoenix', 'Ghost', 'Prince']],
  ['Science', 'science general', ['Scientist', 'Man scientist', 'Woman scientist', 'Ringed planet', 'Astronaut']],
  ['Biology', 'biology anatomy physiology genetics ecology', ['Microbe', 'Anatomical heart', 'Lungs', 'Butterfly', 'Frog']],
  ['Chemistry', 'chemistry chem organic', ['Fire', 'Droplet', 'Snowflake', 'Sun', 'Glowing star']],
  ['Physics', 'physics mechanics astronomy astrophysics', ['Comet', 'Milky way', 'Rocket', 'Shooting star', 'Water wave']],
  ['History', 'history ancient modern', ['Hourglass done', 'Skull and crossbones', 'Old man', 'Old woman', 'Mantelpiece clock']],
  ['Geography', 'geography geo travel', ['Airplane', 'Ship', 'Tornado', 'Compass', 'New moon face']],
  ['Art', 'art drawing painting photography', ['Artist', 'Man artist', 'Camera with flash', 'Nail polish', 'Selfie']],
  ['Music', 'music', ['Musical notes', 'Maracas', 'Singer', 'Man dancing', 'Woman dancing']],
  ['Physical Education', 'pe sport sports fitness physical', ['Person lifting weights', 'Person running', 'Person swimming', 'Person bouncing ball', 'Person fencing']],
  ['Computer Science', 'computer computing programming software coding it', ['Robot', 'Mechanical arm', 'Mechanical leg', 'Eye', 'Star']],
  ['Economics & Business', 'economics business accounting finance commerce marketing', ['Money-mouth face', 'Factory worker', 'Office worker', 'Man office worker', 'Spiral calendar']],
  ['Foreign Languages', 'language languages french spanish german japanese chinese italian latin', ['Speaking head', 'Waving hand', 'Handshake', 'Call me hand', 'Telephone receiver']],
  ['Psychology', 'psychology neuroscience philosophy mind', ['Brain', 'Crystal ball', 'Ear', 'Pensive face', 'Person in lotus position']],
  ['Environmental Science', 'environment environmental climate earth sustainability', ['Leaf fluttering in wind', 'Rainbow', 'Farmer', 'Cloud', 'Fog']],
  ['Design & Technology', 'design technology engineering dt woodwork electronics', ['Construction worker', 'Mechanic', 'Wood', 'High voltage', 'Tractor']],
  ['Drama & Performing Arts', 'drama theatre theater performing dance', ['Person juggling', 'Man juggling', 'Party popper', 'Victory hand', 'Chequered flag']],
  ['Health & Wellbeing', 'health wellbeing medicine nursing medical dentistry', ['Health worker', 'Face with medical mask', 'Ambulance', 'Tooth', 'Flexed biceps']],
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const SUBJECT_ICON_GROUPS: { subject: string; words: string[]; icons: SubjectArt[] }[] = GROUPS.map(([subject, words, names]) => ({
  subject,
  words: words.split(' '),
  icons: names.map((label) => ({ key: slug(label), label, still: url(slug(label), false), anim: url(slug(label), true) }))
    .filter((a): a is SubjectArt => a.still != null),
}));

const BY_KEY = new Map(SUBJECT_ICON_GROUPS.flatMap((g) => g.icons.map((a) => [a.key, a] as const)));

// Lucide keys saved before the art existed: the nearest piece in the same subject.
const OLD: Record<string, string> = {
  sigma: 'hundred-points', pi: 'nerd-face', calculator: 'nerd-face', infinity: 'thinking-face', radical: 'nerd-face',
  atom: 'comet', magnet: 'high-voltage', zap: 'high-voltage', orbit: 'ringed-planet', waves: 'water-wave',
  flask: 'fire', 'flask-round': 'droplet', 'test-tube': 'droplet', 'test-tubes': 'droplet', flame: 'fire',
  dna: 'microbe', microscope: 'microbe', leaf: 'leaf-fluttering-in-wind', bug: 'butterfly', bird: 'owl',
  cpu: 'robot', code: 'robot', database: 'robot', binary: 'robot', keyboard: 'robot', 'file-code': 'robot',
  'book-open': 'writing-hand', feather: 'writing-hand', quote: 'love-letter', 'pen-tool': 'writing-hand', 'book-text': 'writing-hand',
  landmark: 'hourglass-done', scroll: 'hourglass-done', castle: 'prince', hourglass: 'hourglass-done', crown: 'prince',
  globe: 'compass', earth: 'compass', map: 'compass', mountain: 'compass', compass: 'compass',
  languages: 'speaking-head', speech: 'speaking-head', messages: 'speaking-head', mic: 'speaking-head', 'book-marked': 'speaking-head',
  'trending-up': 'money-mouth-face', banknote: 'money-mouth-face', 'chart-line': 'money-mouth-face', 'piggy-bank': 'money-mouth-face',
  dollar: 'money-mouth-face', 'bar-chart': 'money-mouth-face', briefcase: 'office-worker', handshake: 'handshake',
  building: 'office-worker', megaphone: 'speaking-head', target: 'office-worker',
  brain: 'brain', 'brain-circuit': 'brain', lightbulb: 'crystal-ball', puzzle: 'thinking-face', users: 'bust-in-silhouette',
  'heart-pulse': 'anatomical-heart', stethoscope: 'health-worker', pill: 'face-with-medical-mask', syringe: 'health-worker', thermometer: 'face-with-medical-mask',
  dumbbell: 'person-lifting-weights', trophy: 'flexed-biceps', timer: 'stopwatch', bike: 'person-running', volleyball: 'person-bouncing-ball',
  palette: 'artist', paintbrush: 'artist', shapes: 'artist', ruler: 'construction-worker', brush: 'artist',
  music: 'musical-notes', 'music-notes': 'musical-notes', piano: 'musical-notes', guitar: 'singer', radio: 'musical-notes',
  drama: 'person-juggling', theater: 'person-juggling', clapperboard: 'party-popper', ticket: 'party-popper', flag: 'chequered-flag',
  scale: 'thinking-face', gavel: 'thinking-face', shield: 'thinking-face', vote: 'victory-hand', swords: 'person-fencing',
  cog: 'mechanic', wrench: 'mechanic', hammer: 'construction-worker', 'hard-hat': 'construction-worker', rocket: 'rocket',
  tree: 'leaf-fluttering-in-wind', sprout: 'leaf-fluttering-in-wind', telescope: 'ringed-planet', 'map-pinned': 'compass', 'chart-pie': 'money-mouth-face',
};

export const subjectArt = (key: string | null | undefined): SubjectArt | null =>
  key ? BY_KEY.get(key) ?? BY_KEY.get(OLD[key] ?? '') ?? null : null;

/** The group whose subject or keywords appear in a subject's name ("A-level Chemistry" → Chemistry), if any. */
export function matchGroup(name: string) {
  const words = name.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return SUBJECT_ICON_GROUPS.find((g) => g.words.some((w) => words.includes(w))) ?? null;
}

/** Art to give a new subject: the first piece of its matching group, else none (initials). */
export const suggestArt = (name: string) => matchGroup(name)?.icons[0]?.key ?? null;
