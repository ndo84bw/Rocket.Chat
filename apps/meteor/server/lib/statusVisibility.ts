type Viewer = {
	_id: string;
	roles: string[];
	canBypass: boolean;
};

type Target = {
	_id: string;
	adminRoles?: string[];
	deniedByAdmin?: string[];
	deniedByUser?: string[];
};

type CanSeeStatusParams = {
	enabled: boolean;
	systemDefaultRoles?: string[];
	viewer: Viewer;
	target: Target;
};

const audienceOf = (scope?: string[]): string[] | undefined => (scope?.length ? scope : undefined);

const narrow = (a?: string[], b?: string[]): string[] | undefined => {
	if (!a) {
		return b;
	}
	if (!b) {
		return a;
	}
	return a.filter((role) => b.includes(role));
};

type Scopes = {
	systemDefaultRoles?: string[];
	adminRoles?: string[];
};

const ceilingOf = ({ systemDefaultRoles, adminRoles }: Scopes): string[] | undefined =>
	narrow(audienceOf(systemDefaultRoles), audienceOf(adminRoles));

const REDACTED_STATUS_FIELDS = ['statusText', 'statusSource', 'statusExpiresAt', 'statusDefault', 'statusConnection'] as const;

export const redactStatus = <T extends object>(user: T): T => {
	const redacted: Record<string, unknown> = { ...user, status: 'offline' };

	for (const field of REDACTED_STATUS_FIELDS) {
		delete redacted[field];
	}

	return redacted as T;
};

export const canSeeStatus = ({ enabled, systemDefaultRoles, viewer, target }: CanSeeStatusParams): boolean => {
	if (!enabled) {
		return true;
	}

	if (viewer._id === target._id || viewer.canBypass) {
		return true;
	}

	if (target.deniedByAdmin?.includes(viewer._id) || target.deniedByUser?.includes(viewer._id)) {
		return false;
	}

	const effective = ceilingOf({ systemDefaultRoles, adminRoles: target.adminRoles });

	if (!effective) {
		return true;
	}

	return viewer.roles.some((role) => effective.includes(role));
};
