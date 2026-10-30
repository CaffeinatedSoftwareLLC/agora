import { describe, expect, it } from 'vitest';
import { pickerOpenUrl, pushData, readPickerOpen, returnUrl, routeTapOnInstance } from '../src/lib/taps';

const OWN = 'https://a.example.com';
const LOCAL = 'https://localhost';

describe('pushData', () => {
    it('reads the data of a tapped notification', () => {
        expect(pushData({ actionId: 'tap', notification: { data: { instance: OWN, url: '/app/x' } } })).toEqual({ instance: OWN, url: '/app/x' });
        expect(pushData({ actionId: 'tap', notification: {} })).toBeNull();
        expect(pushData(null)).toBeNull();
        expect(pushData({ notification: { data: 'x' } })).toBeNull();
    });
});

describe('routeTapOnInstance', () => {
    it('opens its own links directly', () => {
        expect(routeTapOnInstance({ instance: OWN, url: '/app/01A?thread=01B' }, { origin: OWN, hasHandle: true }, LOCAL))
            .toBe('https://a.example.com/app/01A?thread=01B');
    });

    it('ignores its own links when this device registered no handle there', () => {
        expect(routeTapOnInstance({ instance: OWN, url: '/app/01A' }, { origin: OWN, hasHandle: false }, LOCAL)).toBeNull();
    });

    it('refuses an off-origin url even for itself', () => {
        expect(routeTapOnInstance({ instance: OWN, url: '//evil.com/' }, { origin: OWN, hasHandle: true }, LOCAL)).toBeNull();
    });

    it('hands other instances to the picker, which checks the saved list', () => {
        const own = { origin: OWN, hasHandle: true, href: `${OWN}/app/01Z` };
        const target = routeTapOnInstance({ instance: 'https://b.example.com', url: '/app/01A' }, own, LOCAL);
        expect(target).toBe(pickerOpenUrl(LOCAL, { instance: 'https://b.example.com', url: '/app/01A' }, `${OWN}/app/01Z`));
        expect(target!.startsWith('https://localhost/#open=')).toBe(true);
    });

    it('ignores taps with no instance', () => {
        expect(routeTapOnInstance({ url: '/app/01A' }, { origin: OWN, hasHandle: true }, LOCAL)).toBeNull();
        expect(routeTapOnInstance(null, { origin: OWN, hasHandle: true }, LOCAL)).toBeNull();
    });
});

describe('picker hand-over', () => {
    it('round-trips through the fragment', () => {
        const url = pickerOpenUrl('capacitor://localhost/', { instance: 'https://b.example.com', url: '/app/01A?thread=01B' }, `${OWN}/app/01Z`);
        expect(url.startsWith('capacitor://localhost/#open=')).toBe(true);
        expect(readPickerOpen(new URL(url).hash)).toEqual({
            data: { instance: 'https://b.example.com', url: '/app/01A?thread=01B' },
            from: `${OWN}/app/01Z`,
        });
    });

    it('ignores other fragments and junk', () => {
        expect(readPickerOpen('')).toBeNull();
        expect(readPickerOpen('#other')).toBeNull();
        expect(readPickerOpen('#open=%7B')).toBeNull();
        expect(readPickerOpen('#open=%22x%22')).toBeNull();
        expect(readPickerOpen('#open=%5B%5D')).toBeNull();
        expect(readPickerOpen('#open=%7B%22from%22%3A7%7D')).toEqual({ data: { instance: undefined, url: undefined }, from: null });
    });
});

describe('returnUrl', () => {
    const saved = [OWN];

    it('goes back to the page on a saved server', () => {
        expect(returnUrl(`${OWN}/app/01Z?thread=01Y`, saved)).toBe(`${OWN}/app/01Z?thread=01Y`);
    });

    it('refuses anything else', () => {
        expect(returnUrl(null, saved)).toBeNull();
        expect(returnUrl('https://evil.example.com/app', saved)).toBeNull();
        expect(returnUrl('http://a.example.com/app', saved)).toBeNull();
        expect(returnUrl('javascript:alert(1)', saved)).toBeNull();
        expect(returnUrl('not a url', saved)).toBeNull();
    });
});
