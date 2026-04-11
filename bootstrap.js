if (location.protocol !== 'file:') {
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = 'manifest.webmanifest';
    document.head.appendChild(manifestLink);
}