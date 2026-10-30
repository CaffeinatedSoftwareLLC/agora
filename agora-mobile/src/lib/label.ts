export type NativePlatform = 'android' | 'ios';

/** The subset of @capacitor/device's DeviceInfo the label uses. */
export interface DeviceInfoLike {
    name?: string;
    model?: string;
    manufacturer?: string;
}

const PLATFORM_NAME: Record<NativePlatform, string> = { android: 'Android', ios: 'iOS' };

/**
 * A label the user recognises in their device list, like "Pixel 8 (Android)" or
 * "iPhone (iOS)". On iOS 16+ `name` is the generic model name unless the app has
 * a special entitlement, so a user-chosen device name is not leaked either way.
 */
export function deviceLabel(info: DeviceInfoLike | null | undefined, platform: NativePlatform): string {
    const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '');
    let device = '';
    if (platform === 'android') {
        const model = clean(info?.model);
        const maker = clean(info?.manufacturer);
        device = model && maker && !model.toLowerCase().startsWith(maker.toLowerCase()) && maker.toLowerCase() !== 'google'
            ? `${maker} ${model}`
            : model;
    } else {
        device = clean(info?.name) || (clean(info?.model).startsWith('iPad') ? 'iPad' : 'iPhone');
    }
    const label = `${device || 'Phone'} (${PLATFORM_NAME[platform]})`;
    return label.length > 64 ? `${label.slice(0, 61)}...` : label;
}
