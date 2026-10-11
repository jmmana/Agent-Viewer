import { describe, expect, it } from 'vitest';
import { CREW_STATUS_CLIP, crewClipForStatus, resolveCrewClip } from '../../src/crew/crewClips';

describe('Controlador de clips Crew', () => {
  it('es determinista y cubre cada estado del dominio', () => {
    expect(Object.keys(CREW_STATUS_CLIP)).toHaveLength(23);
    expect(crewClipForStatus('CODING')).toBe('work');
    expect(crewClipForStatus('PHONE_CALL')).toBe('phone');
    expect(crewClipForStatus('ERROR')).toBe('alert');
    expect(crewClipForStatus('NOPE' as never)).toBe('idle');
  });
  it('no declara animación y marca como sustituto los clips sin arte', () => {
    expect(resolveCrewClip('CODING')).toEqual({clip:'work',pose:'work',animated:false,fallback:false});
    expect(resolveCrewClip('IN_MEETING')).toEqual({clip:'meeting',pose:'idle',animated:false,fallback:true});
  });
});
