import { useSetting } from '@rocket.chat/ui-contexts';

import { useHasLicenseModule } from './useHasLicenseModule';

export const useStatusVisibilityEnabled = (): boolean => {
	const enabled = useSetting('Accounts_StatusVisibility_Enabled', false);
	const { data: hasUnlimitedPresence } = useHasLicenseModule('unlimited-presence');
	const { data: hasScalability } = useHasLicenseModule('scalability');

	return enabled && Boolean(hasUnlimitedPresence || hasScalability);
};
