import { api, Authorization, License, Settings } from '@rocket.chat/core-services';
import type { IUser } from '@rocket.chat/core-typings';
import { Users } from '@rocket.chat/models';

import { canSeeStatus } from './statusVisibility';

export type StatusVisibilityChecker = {
	canSee: (targetId: string) => boolean;
	restrictedIds: string[];
};

const ALLOW_ALL: StatusVisibilityChecker = { canSee: () => true, restrictedIds: [] };

const parseRoles = (csv: string): string[] =>
	csv
		.split(',')
		.map((role) => role.trim())
		.filter(Boolean);

const hasPresenceLicense = async (): Promise<boolean> =>
	(await License.hasModule('unlimited-presence')) || License.hasModule('scalability');

export const buildStatusVisibilityChecker = async (
	viewerId: IUser['_id'] | null | undefined,
	targetIds: string[],
): Promise<StatusVisibilityChecker> => {
	if (!targetIds.length || !(await hasPresenceLicense())) {
		return ALLOW_ALL;
	}

	if ((await Settings.get<boolean>('Accounts_StatusVisibility_Enabled')) !== true) {
		return ALLOW_ALL;
	}

	if (viewerId && (await Authorization.hasPermission(viewerId, 'view-restricted-user-status'))) {
		return ALLOW_ALL;
	}

	const viewer = viewerId ? await Users.findOneById<Pick<IUser, '_id' | 'roles'>>(viewerId, { projection: { roles: 1 } }) : undefined;
	const viewerRoles = viewer?.roles ?? [];
	const systemDefaultRoles = parseRoles((await Settings.get<string>('Accounts_StatusVisibility_DefaultRoles')) || '');

	if (systemDefaultRoles.length && !systemDefaultRoles.some((role) => viewerRoles.includes(role))) {
		return { canSee: (targetId) => targetId === viewerId, restrictedIds: targetIds };
	}

	const restricted: IUser[] = await Users.findWithStatusVisibilityConfigByIds(targetIds).toArray();

	if (!restricted.length) {
		return ALLOW_ALL;
	}

	const configured = new Map(restricted.map((user) => [user._id, user] as const));

	const canSee = (targetId: string): boolean => {
		const target = configured.get(targetId);

		if (!target) {
			return true;
		}

		return canSeeStatus({
			enabled: true,
			systemDefaultRoles,
			viewer: { _id: viewerId ?? '', roles: viewerRoles, canBypass: false },
			target: {
				_id: target._id,
				adminRoles: target.statusVisibilityRoles,
				deniedByAdmin: target.statusVisibilityDenied,
				deniedByUser: target.settings?.preferences?.statusVisibilityDenied,
			},
		});
	};

	return { canSee, restrictedIds: restricted.map((user) => user._id) };
};

const verdicts = new Map<IUser['_id'], Map<IUser['_id'], boolean>>();

const restrictedTargets = new Set<IUser['_id']>();

const rememberVerdicts = (
	viewerId: IUser['_id'],
	targetIds: IUser['_id'][],
	canSee: (targetId: IUser['_id']) => boolean,
	restrictedIds: IUser['_id'][],
): void => {
	if (!targetIds.length) {
		return;
	}

	const known = verdicts.get(viewerId) ?? new Map<IUser['_id'], boolean>();

	restrictedIds.forEach((targetId) => restrictedTargets.add(targetId));

	for (const targetId of targetIds) {
		const allowed = canSee(targetId);

		if (allowed && !restrictedTargets.has(targetId)) {
			known.delete(targetId);
			continue;
		}

		known.set(targetId, allowed);
	}

	verdicts.set(viewerId, known);
};

export const shouldHideStatus = (viewerId: IUser['_id'], targetId: IUser['_id']): boolean => {
	const known = verdicts.get(viewerId)?.get(targetId);

	if (known !== undefined) {
		return !known;
	}

	return restrictedTargets.has(targetId);
};

const invalidateViewer = (viewerId: IUser['_id']): void => {
	verdicts.delete(viewerId);
};

const invalidateTarget = (targetId: IUser['_id']): void => {
	restrictedTargets.add(targetId);

	for (const known of verdicts.values()) {
		known.delete(targetId);
	}
};

const invalidateAll = (): void => {
	verdicts.clear();
};

export const warmStatusVisibility = async (viewerId: IUser['_id'], targetIds: IUser['_id'][]): Promise<void> => {
	if (!targetIds.length) {
		return;
	}

	const { canSee, restrictedIds } = await buildStatusVisibilityChecker(viewerId, targetIds);

	rememberVerdicts(viewerId, targetIds, canSee, restrictedIds);
};

export const applyStatusVisibilityInvalidation = ({ targets, viewers }: { targets?: IUser['_id'][]; viewers?: IUser['_id'][] }): void => {
	if (!targets?.length && !viewers?.length) {
		invalidateAll();
		return;
	}

	targets?.forEach(invalidateTarget);
	viewers?.forEach(invalidateViewer);
};

export const notifyStatusVisibilityChanged = (payload: { targets?: IUser['_id'][]; viewers?: IUser['_id'][] } = {}): void => {
	applyStatusVisibilityInvalidation(payload);

	void api.broadcast('presence.invalidateVisibility', payload).catch(() => undefined);
};
