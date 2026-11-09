/* The icons a subject can wear (its tile in the side bar and home page): five for each of twenty common subjects,
   all Lucide (bundled, offline). Stored by key in `subjects.icon_name`; an unknown key falls back to the letters. */
import {
  Atom, BadgeDollarSign, Banknote, BarChart3, Binary, Bird, BookMarked, BookOpen, BookOpenText, Brain, BrainCircuit, Briefcase,
  Bug, Building2, Calculator, ChartLine, ChartPie, Cog, Code, Compass, Cpu, Database, Dna, Drama, Dumbbell, FileCode,
  FlaskConical, FlaskRound, Gavel, Globe, Guitar, Handshake, HeartPulse, Hourglass, Infinity as InfinityIcon, Landmark,
  Languages, Leaf, Lightbulb, LucideIcon, Magnet, MapPinned, Map as MapIcon, Megaphone, MessagesSquare, Microscope,
  Mountain, Music, Music4, Paintbrush, Palette, PenTool, Pi, Piano, PiggyBank, Pill, Puzzle, Quote, Radical, Ruler,
  Scale, ScrollText, Shapes, Shield, Sigma, Sprout, Stethoscope, Swords, Syringe, Target, TestTube, TestTubes, Theater,
  Timer, TreePine, TrendingUp, Trophy, Users, Waves, Wrench, Zap, Bike, Castle, Crown, Feather, Flag, Hammer, HardHat,
  Keyboard, Mic, Orbit, Rocket, Speech, Telescope, Thermometer, Volleyball, Earth, Flame, Brush, Radio, Clapperboard, Ticket, Vote,
} from 'lucide-react';

export const SUBJECT_ICON_GROUPS: { subject: string; icons: [string, LucideIcon][] }[] = [
  { subject: 'Maths', icons: [['sigma', Sigma], ['pi', Pi], ['calculator', Calculator], ['infinity', InfinityIcon], ['radical', Radical]] },
  { subject: 'Physics', icons: [['atom', Atom], ['magnet', Magnet], ['zap', Zap], ['orbit', Orbit], ['waves', Waves]] },
  { subject: 'Chemistry', icons: [['flask', FlaskConical], ['flask-round', FlaskRound], ['test-tube', TestTube], ['test-tubes', TestTubes], ['flame', Flame]] },
  { subject: 'Biology', icons: [['dna', Dna], ['microscope', Microscope], ['leaf', Leaf], ['bug', Bug], ['bird', Bird]] },
  { subject: 'Computing', icons: [['cpu', Cpu], ['code', Code], ['database', Database], ['binary', Binary], ['keyboard', Keyboard]] },
  { subject: 'English', icons: [['book-open', BookOpen], ['feather', Feather], ['quote', Quote], ['pen-tool', PenTool], ['book-text', BookOpenText]] },
  { subject: 'History', icons: [['landmark', Landmark], ['scroll', ScrollText], ['castle', Castle], ['hourglass', Hourglass], ['crown', Crown]] },
  { subject: 'Geography', icons: [['globe', Globe], ['earth', Earth], ['map', MapIcon], ['mountain', Mountain], ['compass', Compass]] },
  { subject: 'Languages', icons: [['languages', Languages], ['speech', Speech], ['messages', MessagesSquare], ['mic', Mic], ['book-marked', BookMarked]] },
  { subject: 'Economics', icons: [['trending-up', TrendingUp], ['banknote', Banknote], ['chart-line', ChartLine], ['piggy-bank', PiggyBank], ['dollar', BadgeDollarSign]] },
  { subject: 'Business', icons: [['briefcase', Briefcase], ['handshake', Handshake], ['building', Building2], ['megaphone', Megaphone], ['target', Target]] },
  { subject: 'Psychology', icons: [['brain', Brain], ['brain-circuit', BrainCircuit], ['lightbulb', Lightbulb], ['puzzle', Puzzle], ['users', Users]] },
  { subject: 'Health & medicine', icons: [['heart-pulse', HeartPulse], ['stethoscope', Stethoscope], ['pill', Pill], ['syringe', Syringe], ['thermometer', Thermometer]] },
  { subject: 'Physical education', icons: [['dumbbell', Dumbbell], ['trophy', Trophy], ['timer', Timer], ['bike', Bike], ['volleyball', Volleyball]] },
  { subject: 'Art & design', icons: [['palette', Palette], ['paintbrush', Paintbrush], ['shapes', Shapes], ['ruler', Ruler], ['brush', Brush]] },
  { subject: 'Music', icons: [['music', Music], ['music-notes', Music4], ['piano', Piano], ['guitar', Guitar], ['radio', Radio]] },
  { subject: 'Drama', icons: [['drama', Drama], ['theater', Theater], ['clapperboard', Clapperboard], ['ticket', Ticket], ['flag', Flag]] },
  { subject: 'Law & politics', icons: [['scale', Scale], ['gavel', Gavel], ['shield', Shield], ['vote', Vote], ['swords', Swords]] },
  { subject: 'Engineering', icons: [['cog', Cog], ['wrench', Wrench], ['hammer', Hammer], ['hard-hat', HardHat], ['rocket', Rocket]] },
  { subject: 'Environment & space', icons: [['tree', TreePine], ['sprout', Sprout], ['telescope', Telescope], ['map-pinned', MapPinned], ['chart-pie', ChartPie]] },
];

const BY_KEY = new Map(SUBJECT_ICON_GROUPS.flatMap((g) => g.icons));
// older keys / spare imports kept resolvable
BY_KEY.set('bar-chart', BarChart3); BY_KEY.set('file-code', FileCode);

export const subjectIcon = (key: string | null | undefined): LucideIcon | null => (key ? BY_KEY.get(key) ?? null : null);
