export type ParticipantMuteStates=Record<string,boolean>;
export type VoiceOccupancy=Record<string,number>;

export function reconcileParticipantMuted(states:ParticipantMuteStates,userId:string,muted:boolean):ParticipantMuteStates{return {...states,[userId]:muted};}
export function reconcileMutedParticipants(userIds:string[]):ParticipantMuteStates{return Object.fromEntries(userIds.map(userId=>[userId,true]));}
export function isMutedByModerator(states:ParticipantMuteStates,userId:string){return states[userId]===true;}
export function reconcileVoiceOccupancy(occupancy:VoiceOccupancy,channelId:string,count:number):VoiceOccupancy{return {...occupancy,[channelId]:count};}
