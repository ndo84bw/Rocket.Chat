import {
	applyStatusVisibilityInvalidation,
	buildStatusVisibilityChecker,
	shouldHideStatus,
	warmStatusVisibility,
} from './statusVisibilityChecker';

const hasModule = jest.fn();
const getSetting = jest.fn();
const hasPermission = jest.fn();
const findWithStatusVisibilityConfigByIds = jest.fn();
const findOneById = jest.fn();

jest.mock('@rocket.chat/core-services', () => ({
	License: { hasModule: (m: string) => hasModule(m) },
	Settings: { get: (key: string) => getSetting(key) },
	Authorization: { hasPermission: (...args: unknown[]) => hasPermission(...args) },
}));
jest.mock('@rocket.chat/models', () => ({
	Users: {
		findWithStatusVisibilityConfigByIds: (...args: unknown[]) => findWithStatusVisibilityConfigByIds(...args),
		findOneById: (...args: unknown[]) => findOneById(...args),
	},
}));

const restricted = (users: object[]) => ({ toArray: async () => users });

describe('buildStatusVisibilityChecker', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		hasModule.mockReturnValue(true);
		getSetting.mockImplementation(async (key: string) => (key === 'Accounts_StatusVisibility_Enabled' ? true : ''));
		hasPermission.mockResolvedValue(false);
		findOneById.mockResolvedValue({ _id: 'bruno', roles: ['user'] });
		findWithStatusVisibilityConfigByIds.mockReturnValue(restricted([]));
	});

	describe('short circuits, in the order they are meant to fire', () => {
		it('allows everyone when the toggle is off, without touching the database', async () => {
			getSetting.mockResolvedValue(false);

			const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana']);

			expect(canSee('ana')).toBe(true);
			expect(findWithStatusVisibilityConfigByIds).not.toHaveBeenCalled();
		});

		it('allows everyone when no presence module is licensed, without even reading the setting', async () => {
			hasModule.mockReturnValue(false);

			const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana']);

			expect(canSee('ana')).toBe(true);
			expect(getSetting).not.toHaveBeenCalled();
		});

		it('accepts either presence module, matching how presence itself is gated', async () => {
			hasModule.mockImplementation((module: string) => module === 'scalability');
			findWithStatusVisibilityConfigByIds.mockReturnValue(restricted([{ _id: 'ana', statusVisibilityRoles: ['hr'] }]));

			const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana']);

			expect(canSee('ana')).toBe(false);
		});

		it('allows everyone for a viewer holding the bypass permission', async () => {
			hasPermission.mockResolvedValue(true);

			const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana']);

			expect(canSee('ana')).toBe(true);
			expect(findWithStatusVisibilityConfigByIds).not.toHaveBeenCalled();
		});

		it('shows nothing but themselves to a viewer outside the system default', async () => {
			getSetting.mockImplementation(async (key: string) => (key === 'Accounts_StatusVisibility_Enabled' ? true : 'manager'));

			const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana', 'bruno']);

			expect(canSee('ana')).toBe(false);
			expect(canSee('bruno')).toBe(true);
		});
	});

	it('never grants the bypass to an anonymous caller', async () => {
		findWithStatusVisibilityConfigByIds.mockReturnValue(restricted([{ _id: 'ana', statusVisibilityRoles: ['user'] }]));

		const { canSee } = await buildStatusVisibilityChecker(null, ['ana']);

		expect(hasPermission).not.toHaveBeenCalled();
		expect(canSee('ana')).toBe(false);
	});

	it('lets an unconfigured target through without consulting the predicate', async () => {
		findWithStatusVisibilityConfigByIds.mockReturnValue(restricted([{ _id: 'ana', statusVisibilityRoles: ['hr'] }]));

		const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana', 'carla']);

		expect(canSee('carla')).toBe(true);
	});

	it('reports which targets are configured, so the cache can fail closed later', async () => {
		findWithStatusVisibilityConfigByIds.mockReturnValue(restricted([{ _id: 'ana', statusVisibilityDenied: ['bruno'] }]));

		const { canSee, restrictedIds } = await buildStatusVisibilityChecker('bruno', ['ana', 'carla']);

		expect(restrictedIds).toEqual(['ana']);
		expect(canSee('ana')).toBe(false);
	});

	it('applies a block the user set on themselves', async () => {
		findWithStatusVisibilityConfigByIds.mockReturnValue(
			restricted([{ _id: 'ana', settings: { preferences: { statusVisibilityDenied: ['bruno'] } } }]),
		);

		const { canSee } = await buildStatusVisibilityChecker('bruno', ['ana']);

		expect(canSee('ana')).toBe(false);
	});
});

describe('the verdict cache the emit path reads', () => {
	const configured = (users: object[]) => findWithStatusVisibilityConfigByIds.mockReturnValue(restricted(users));

	beforeEach(() => {
		applyStatusVisibilityInvalidation({});
		hasModule.mockReturnValue(true);
		getSetting.mockImplementation(async (key: string) => (key === 'Accounts_StatusVisibility_Enabled' ? true : ''));
		hasPermission.mockResolvedValue(false);
		findOneById.mockResolvedValue({ _id: 'bruno', roles: ['user'] });
	});

	it('hides nobody before anything is known', () => {
		expect(shouldHideStatus('bruno', 'never-configured')).toBe(false);
	});

	it('hides a target the check denied, and only that one', async () => {
		configured([{ _id: 'ana', statusVisibilityDenied: ['bruno'] }]);
		await warmStatusVisibility('bruno', ['ana', 'carla']);

		expect(shouldHideStatus('bruno', 'ana')).toBe(true);
		expect(shouldHideStatus('bruno', 'carla')).toBe(false);
	});

	it('keeps verdicts apart per viewer', async () => {
		configured([{ _id: 'ana', statusVisibilityDenied: ['bruno'] }]);
		await warmStatusVisibility('bruno', ['ana']);

		findOneById.mockResolvedValue({ _id: 'carla', roles: ['user'] });
		await warmStatusVisibility('carla', ['ana']);

		expect(shouldHideStatus('bruno', 'ana')).toBe(true);
		expect(shouldHideStatus('carla', 'ana')).toBe(false);
	});

	describe('failing closed', () => {
		it('hides a configured target whose verdict was dropped', async () => {
			configured([{ _id: 'ana', statusVisibilityDenied: ['bruno'] }]);
			await warmStatusVisibility('bruno', ['ana']);

			applyStatusVisibilityInvalidation({ viewers: ['bruno'] });

			expect(shouldHideStatus('bruno', 'ana')).toBe(true);
		});

		it('still lets unconfigured targets through after an invalidation', async () => {
			configured([{ _id: 'ana', statusVisibilityDenied: ['bruno'] }]);
			await warmStatusVisibility('bruno', ['ana', 'carla']);

			applyStatusVisibilityInvalidation({ viewers: ['bruno'] });

			expect(shouldHideStatus('bruno', 'carla')).toBe(false);
		});

		it('remembers a target is configured even when this viewer may see it', async () => {
			configured([{ _id: 'ana', statusVisibilityRoles: ['user'] }]);
			await warmStatusVisibility('bruno', ['ana']);

			expect(shouldHideStatus('bruno', 'ana')).toBe(false);

			applyStatusVisibilityInvalidation({ viewers: ['bruno'] });

			expect(shouldHideStatus('bruno', 'ana')).toBe(true);
		});
	});

	it('drops every viewer when the ceiling itself moves', async () => {
		configured([{ _id: 'ana', statusVisibilityRoles: ['user'] }]);
		await warmStatusVisibility('bruno', ['ana']);

		expect(shouldHideStatus('bruno', 'ana')).toBe(false);

		applyStatusVisibilityInvalidation({});

		expect(shouldHideStatus('bruno', 'ana')).toBe(true);
	});
});
