import { afterEach, describe, expect, it } from 'vitest';
import { startTour, TOUR_GROUPS, TourId, TOURS, tourRunning } from '../../src/components/Tour';

const ids = Object.keys(TOURS) as TourId[];

describe('the tours', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('each belongs to a group the help window shows, with a name and somewhere to find it', () => {
    for (const id of ids) {
      expect(TOUR_GROUPS, id).toContain(TOURS[id].group);
      expect(TOURS[id].title.trim(), id).not.toBe('');
      expect(TOURS[id].where.trim(), id).not.toBe('');
    }
  });

  it('has the subject page and a tour of each of its panels', () => {
    for (const id of ['app', 'files', 'mynotes', 'library', 'studysheet', 'make', 'minibar']) expect(ids).toContain(id);
  });

  it('keeps every tip short, titled, and pointed at a valid selector', () => {
    for (const id of ids) {
      expect(TOURS[id].steps.length, id).toBeGreaterThan(0);
      for (const s of TOURS[id].steps) {
        expect(s.title.trim(), `${id}: ${s.body}`).not.toBe('');
        // one to three sentences (a ? ends one only before a capital: "The ? on My notes" doesn't)
        const sentences = s.body.split(/[.!](?:\s|$)|\?(?:\s+(?=[A-Z“])|$)/).filter((x) => x.trim()).length;
        expect(sentences, `${id} · ${s.title}`).toBeLessThanOrEqual(3);
        if (s.at) for (const sel of s.at.split(/,\s*/)) expect(() => document.querySelectorAll(sel), `${id} · ${sel}`).not.toThrow();
      }
    }
  });

  it('shows every tip in the middle when its part of the screen is not there, unless it started by itself', () => {
    expect(startTour('mynotes', { auto: true })).toBe(false);
    expect(tourRunning()).toBe(false);
    expect(startTour('mynotes')).toBe(true);
    expect(tourRunning()).toBe(true);
  });
});
