/** Quote a string as a single POSIX shell word, safe to interpolate into `sh -c` commands. */
export function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
