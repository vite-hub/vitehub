// A local picture for the avatar and the image cropper, so the fixture needs no network.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640" viewBox="0 0 960 640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0ea5e9"/><stop offset="1" stop-color="#4338ca"/></linearGradient></defs><rect width="960" height="640" fill="url(#g)"/><circle cx="700" cy="220" r="120" fill="#fde68a"/><path d="M0 520 300 300l220 160 160-100 280 160v120H0z" fill="#0f172a" opacity=".55"/></svg>`;

export const picture = `data:image/svg+xml,${encodeURIComponent(svg)}`;
