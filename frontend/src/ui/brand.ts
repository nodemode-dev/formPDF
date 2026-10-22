const LOGO = '/formpdf-logo.png';

export function brandMark(size: number, label = ''): string {
  return `<img class="fs-mark" src="${LOGO}" width="${size}" height="${size}" alt="${label}" draggable="false">`;
}
