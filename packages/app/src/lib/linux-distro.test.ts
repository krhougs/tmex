import { describe, expect, test } from 'bun:test';
import { detectPackageManager, parseOsRelease, type LinuxDistroInfo } from './linux-distro';

describe('parseOsRelease', () => {
  test('parses Ubuntu os-release', () => {
    const content = `NAME="Ubuntu"
VERSION="22.04.3 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
VERSION_ID="22.04"
HOME_URL="https://www.ubuntu.com/"
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'ubuntu',
      idLike: ['debian'],
      versionId: '22.04',
      name: 'Ubuntu',
    });
  });

  test('parses Fedora os-release', () => {
    const content = `NAME="Fedora Linux"
ID=fedora
VERSION_ID="39"
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'fedora',
      idLike: [],
      versionId: '39',
      name: 'Fedora Linux',
    });
  });

  test('parses Arch os-release', () => {
    const content = `NAME="Arch Linux"
ID=arch
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'arch',
      idLike: [],
      versionId: undefined,
      name: 'Arch Linux',
    });
  });

  test('parses Alpine os-release', () => {
    const content = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.19.0
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'alpine',
      idLike: [],
      versionId: '3.19.0',
      name: 'Alpine Linux',
    });
  });

  test('parses openSUSE os-release', () => {
    const content = `NAME="openSUSE Tumbleweed"
ID="opensuse-tumbleweed"
ID_LIKE="opensuse suse"
VERSION_ID="20240101"
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'opensuse-tumbleweed',
      idLike: ['opensuse', 'suse'],
      versionId: '20240101',
      name: 'openSUSE Tumbleweed',
    });
  });

  test('parses CentOS with ID_LIKE containing multiple values', () => {
    const content = `NAME="CentOS Stream"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="9"
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'centos',
      idLike: ['rhel', 'fedora'],
      versionId: '9',
      name: 'CentOS Stream',
    });
  });

  test('parses Manjaro with ID_LIKE=arch', () => {
    const content = `NAME="Manjaro Linux"
ID=manjaro
ID_LIKE=arch
`;
    const result = parseOsRelease(content);
    expect(result).toEqual({
      id: 'manjaro',
      idLike: ['arch'],
      versionId: undefined,
      name: 'Manjaro Linux',
    });
  });

  test('returns null when ID is missing', () => {
    const content = `NAME="Some OS"
VERSION_ID="1.0"
`;
    expect(parseOsRelease(content)).toBeNull();
  });

  test('returns null for empty content', () => {
    expect(parseOsRelease('')).toBeNull();
  });

  test('handles single-quoted values', () => {
    const content = `ID='ubuntu'
NAME='Ubuntu'
`;
    const result = parseOsRelease(content);
    expect(result?.id).toBe('ubuntu');
    expect(result?.name).toBe('Ubuntu');
  });

  test('ignores comment lines', () => {
    const content = `# this is a comment
ID=ubuntu
`;
    const result = parseOsRelease(content);
    expect(result?.id).toBe('ubuntu');
  });
});

describe('detectPackageManager', () => {
  test('returns brew for macOS', () => {
    expect(detectPackageManager(null, 'darwin')).toBe('brew');
  });

  test('returns apt for debian-based', () => {
    const distro: LinuxDistroInfo = { id: 'ubuntu', idLike: ['debian'] };
    expect(detectPackageManager(distro, 'linux')).toBe('apt');
  });

  test('returns apt for debian itself', () => {
    const distro: LinuxDistroInfo = { id: 'debian', idLike: [] };
    expect(detectPackageManager(distro, 'linux')).toBe('apt');
  });

  test('returns dnf for fedora', () => {
    const distro: LinuxDistroInfo = { id: 'fedora', idLike: [] };
    expect(detectPackageManager(distro, 'linux')).toBe('dnf');
  });

  test('returns dnf for rhel-based via ID_LIKE', () => {
    const distro: LinuxDistroInfo = { id: 'centos', idLike: ['rhel', 'fedora'] };
    expect(detectPackageManager(distro, 'linux')).toBe('dnf');
  });

  test('returns pacman for arch', () => {
    const distro: LinuxDistroInfo = { id: 'arch', idLike: [] };
    expect(detectPackageManager(distro, 'linux')).toBe('pacman');
  });

  test('returns pacman for manjaro via ID_LIKE', () => {
    const distro: LinuxDistroInfo = { id: 'manjaro', idLike: ['arch'] };
    expect(detectPackageManager(distro, 'linux')).toBe('pacman');
  });

  test('returns apk for alpine', () => {
    const distro: LinuxDistroInfo = { id: 'alpine', idLike: [] };
    expect(detectPackageManager(distro, 'linux')).toBe('apk');
  });

  test('returns zypper for opensuse', () => {
    const distro: LinuxDistroInfo = { id: 'opensuse-tumbleweed', idLike: ['opensuse', 'suse'] };
    expect(detectPackageManager(distro, 'linux')).toBe('zypper');
  });

  test('returns unknown for null distro on linux', () => {
    expect(detectPackageManager(null, 'linux')).toBe('unknown');
  });

  test('returns unknown for unrecognized distro', () => {
    const distro: LinuxDistroInfo = { id: 'nixos', idLike: [] };
    expect(detectPackageManager(distro, 'linux')).toBe('unknown');
  });

  test('returns unknown for non-linux/darwin platform', () => {
    expect(detectPackageManager(null, 'win32')).toBe('unknown');
  });
});
