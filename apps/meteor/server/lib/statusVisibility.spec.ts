import { canSeeStatus, redactStatus } from './statusVisibility';

describe('canSeeStatus', () => {
	it('allows any viewer when the feature is disabled', () => {
		expect(
			canSeeStatus({
				enabled: false,
				systemDefaultRoles: ['hr'],
				viewer: { _id: 'bruno', roles: ['user'], canBypass: false },
				target: { _id: 'ana', adminRoles: ['hr'] },
			}),
		).toBe(true);
	});

	it('allows any viewer when nothing is configured', () => {
		expect(
			canSeeStatus({
				enabled: true,
				viewer: { _id: 'bruno', roles: ['user'], canBypass: false },
				target: { _id: 'ana' },
			}),
		).toBe(true);
	});

	it('shows the status to a viewer holding a role the user selected', () => {
		expect(
			canSeeStatus({
				enabled: true,
				viewer: { _id: 'carla', roles: ['user', 'hr'], canBypass: false },
				target: { _id: 'ana', adminRoles: ['hr'] },
			}),
		).toBe(true);
	});

	it('hides the status from a viewer holding no role in the audience', () => {
		expect(
			canSeeStatus({
				enabled: true,
				viewer: { _id: 'bruno', roles: ['user', 'manager'], canBypass: false },
				target: { _id: 'ana', adminRoles: ['hr'] },
			}),
		).toBe(false);
	});

	it('always shows users their own status, even when their audience excludes their roles', () => {
		expect(
			canSeeStatus({
				enabled: true,
				viewer: { _id: 'ana', roles: ['user'], canBypass: false },
				target: { _id: 'ana', adminRoles: ['hr'] },
			}),
		).toBe(true);
	});

	it('shows the real status to a viewer holding the bypass permission', () => {
		expect(
			canSeeStatus({
				enabled: true,
				viewer: { _id: 'admin', roles: ['user'], canBypass: true },
				target: { _id: 'ana', adminRoles: ['hr'] },
			}),
		).toBe(true);
	});
});

describe('canSeeStatus — case matrix', () => {
	const check = (params: Parameters<typeof canSeeStatus>[0]) => canSeeStatus(params);

	const viewer = (roles: string[]) => ({ _id: 'bruno', roles, canBypass: false });

	it('applies an admin override to a user who made no pick of their own', () => {
		expect(check({ enabled: true, viewer: viewer(['manager']), target: { _id: 'ana', adminRoles: ['manager', 'hr'] } })).toBe(true);
		expect(check({ enabled: true, viewer: viewer(['support']), target: { _id: 'ana', adminRoles: ['manager', 'hr'] } })).toBe(false);
	});

	it('narrows the system default by the admin override to form the ceiling', () => {
		const target = { _id: 'ana', adminRoles: ['manager', 'hr'] };
		const systemDefaultRoles = ['manager', 'hr', 'support'];

		expect(check({ enabled: true, systemDefaultRoles, viewer: viewer(['manager']), target })).toBe(true);
		// 'support' is in the system default but not in the admin override, so the ceiling excludes it
		expect(check({ enabled: true, systemDefaultRoles, viewer: viewer(['support']), target })).toBe(false);
	});

	it('lets a named block narrow below what the roles granted', () => {
		const target = { _id: 'ana', adminRoles: ['manager', 'hr'], deniedByUser: ['bruno'] };

		expect(check({ enabled: true, viewer: { _id: 'carla', roles: ['hr'], canBypass: false }, target })).toBe(true);
		expect(check({ enabled: true, viewer: { _id: 'bruno', roles: ['manager'], canBypass: false }, target })).toBe(false);
	});

	it('treats an empty array the same as an unset scope', () => {
		expect(check({ enabled: true, systemDefaultRoles: [], viewer: viewer(['user']), target: { _id: 'ana', adminRoles: [] } })).toBe(true);
	});

	it('keeps a user hidden when their audience references a role that no longer exists', () => {
		expect(check({ enabled: true, viewer: viewer(['user', 'manager']), target: { _id: 'ana', adminRoles: ['deleted-role'] } })).toBe(false);
	});
});

describe('redactStatus', () => {
	it('leaves nothing that could contradict the fabricated offline state', () => {
		expect(
			redactStatus({
				_id: 'ana',
				username: 'ana',
				status: 'busy',
				statusText: 'Away until 20/08',
				statusSource: 'external',
				statusExpiresAt: new Date(),
				statusDefault: 'online',
				statusConnection: 'online',
			}),
		).toEqual({ _id: 'ana', username: 'ana', status: 'offline' });
	});
});

describe('canSeeStatus — denial lists', () => {
	const viewer = { _id: 'bruno', roles: ['user', 'hr'], canBypass: false };

	it('hides the status from someone the user blocked', () => {
		expect(canSeeStatus({ enabled: true, viewer, target: { _id: 'ana', deniedByUser: ['bruno'] } })).toBe(false);
	});

	it('hides the status from someone an admin blocked', () => {
		expect(canSeeStatus({ enabled: true, viewer, target: { _id: 'ana', deniedByAdmin: ['bruno'] } })).toBe(false);
	});

	it('blocks even a viewer whose role would otherwise grant access', () => {
		expect(canSeeStatus({ enabled: true, viewer, target: { _id: 'ana', adminRoles: ['hr'], deniedByUser: ['bruno'] } })).toBe(false);
	});

	it('still shows users their own status if they somehow appear in their own list', () => {
		expect(
			canSeeStatus({ enabled: true, viewer: { _id: 'ana', roles: [], canBypass: false }, target: { _id: 'ana', deniedByUser: ['ana'] } }),
		).toBe(true);
	});

	it('lets the bypass permission through a denial', () => {
		expect(canSeeStatus({ enabled: true, viewer: { ...viewer, canBypass: true }, target: { _id: 'ana', deniedByUser: ['bruno'] } })).toBe(
			true,
		);
	});
});
