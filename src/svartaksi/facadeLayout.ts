/** Pure geometry: fits a whole-number grid of window modules onto a wall, given a facade profile's spacing. */
import type { FacadeProfile } from './buildingFacade';

export interface FacadeLayout {
  columns: number;
  rows: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Fit complete window modules inside a wall and split all unused space evenly.
 * Coordinates are measured from the wall's lower-left corner.
 */
export function solveFacadeLayout(
  wallWidth: number,
  wallHeight: number,
  profile: FacadeProfile,
): FacadeLayout | null {
  const values = [
    wallWidth,
    wallHeight,
    profile.firstFloorHeight,
    profile.roofPadding,
    profile.sidePadding,
    profile.windowWidth,
    profile.windowHeight,
    profile.windowSpacingX,
    profile.windowSpacingY,
    profile.litRatio,
  ];
  if (values.some(value => !Number.isFinite(value)) || values.some(value => value < 0)) {
    return null;
  }
  if (
    wallWidth <= 0 ||
    wallHeight <= 0 ||
    profile.windowWidth <= 0 ||
    profile.windowHeight <= 0 ||
    profile.windowSpacingX < profile.windowWidth ||
    profile.windowSpacingY < profile.windowHeight ||
    profile.litRatio > 1
  ) {
    return null;
  }

  const availableWidth = wallWidth - profile.sidePadding * 2;
  const availableHeight = wallHeight - profile.firstFloorHeight - profile.roofPadding;
  if (availableWidth < profile.windowWidth || availableHeight < profile.windowHeight) return null;

  const columns = Math.floor((availableWidth - profile.windowWidth) / profile.windowSpacingX) + 1;
  const rows = Math.floor((availableHeight - profile.windowHeight) / profile.windowSpacingY) + 1;
  if (columns < 1 || rows < 1) return null;

  const occupiedWidth = (columns - 1) * profile.windowSpacingX + profile.windowWidth;
  const occupiedHeight = (rows - 1) * profile.windowSpacingY + profile.windowHeight;
  const startX = profile.sidePadding + (availableWidth - occupiedWidth) / 2;
  const startY = profile.firstFloorHeight + (availableHeight - occupiedHeight) / 2;

  return {
    columns,
    rows,
    startX,
    startY,
    endX: startX + occupiedWidth,
    endY: startY + occupiedHeight,
  };
}
