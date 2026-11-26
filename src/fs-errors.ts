/** Node filesystem failures expose string error codes; other thrown values need not. */
export function fsErrorCode(error: unknown): string | undefined {
	if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}
