export const VISIBILITIES=['private','linked-projects','career','publishing','public-safe']
export const DISCLOSURES=['internal-only','review-required','publish-approved']
export const SENSITIVITIES=['public','none','personal','application-private','compensation-confidential','third-party-personal','recruiter-confidential','employer-confidential','restricted']
export const DOCUMENT_ROLES=['policy','evidence','content']
export const CONFIDENCE_SUGGESTIONS=['confirmed','mixed','unverified']
export const CONFIDENTIAL_SENSITIVITIES=['application-private','compensation-confidential','third-party-personal','recruiter-confidential','employer-confidential','restricted']

export function derivedPublicSafe(metadata={}){return metadata.disclosure==='publish-approved'&&!CONFIDENTIAL_SENSITIVITIES.includes(metadata.sensitivity)}

export function annotationSchema(lenses=[]){return {
 schema_version:1,
 fields:{
  access_lenses:{type:'multi-select',required:true,options:lenses.map(lens=>({value:lens.id,label:lens.title||lens.id,source:lens.source||'unknown'}))},
  disclosure:{type:'single-select',required:true,options:DISCLOSURES},
  sensitivity:{type:'single-select',required:true,options:SENSITIVITIES},
  document_role:{type:'single-select',required:true,options:DOCUMENT_ROLES},
  confidence:{type:'editable-select',required:false,suggestions:CONFIDENCE_SUGGESTIONS},
  visibility:{type:'single-select',required:false,legacy:true,options:VISIBILITIES},
  public_safe:{type:'derived-override',required:false,legacy:true}
 }
}}

export function validateAnnotationMetadata(metadata={},knownLenses=[],{allowLegacy=false}={}){const errors=[],warnings=[],known=new Set(knownLenses),modern=Array.isArray(metadata.access_lenses)
 if(!modern||!metadata.access_lenses.length){if(allowLegacy&&!modern&&metadata.visibility)warnings.push('Legacy visibility metadata preserved; add Access Lenses to use modern policy controls.');else errors.push('Select at least one Access Lens; unscoped knowledge fails closed.')}
 else if(metadata.access_lenses.some(value=>typeof value!=='string'||!value.trim()))errors.push('Access Lenses must contain non-empty identifiers.')
 const unknown=(metadata.access_lenses||[]).filter(value=>known.size&&!known.has(value));if(unknown.length)warnings.push(`Unknown or legacy Access Lenses preserved: ${unknown.join(', ')}.`)
 for(const [field,values] of [['disclosure',DISCLOSURES],['sensitivity',SENSITIVITIES],['document_role',DOCUMENT_ROLES]])if(modern&&!values.includes(metadata[field]))errors.push(`${field} must be one of: ${values.join(', ')}.`);else if(metadata[field]!==undefined&&!values.includes(metadata[field]))errors.push(`${field} must be one of: ${values.join(', ')}.`)
 if(metadata.visibility!==undefined&&!VISIBILITIES.includes(metadata.visibility))errors.push(`visibility must be one of: ${VISIBILITIES.join(', ')}.`)
 if(metadata.confidence!==undefined&&(typeof metadata.confidence!=='string'||!metadata.confidence.trim()))errors.push('confidence must be non-empty when set.')
 if(metadata.public_safe!==undefined&&metadata.public_safe!==null&&typeof metadata.public_safe!=='boolean')errors.push('public_safe must be true, false, or derived.')
 if(metadata.disclosure==='publish-approved'&&CONFIDENTIAL_SENSITIVITIES.includes(metadata.sensitivity))errors.push(`publish-approved cannot be combined with ${metadata.sensitivity}.`)
 if(metadata.public_safe===true&&metadata.disclosure==='internal-only')errors.push('public_safe: true cannot be combined with internal-only.')
 if(metadata.visibility==='public-safe'&&metadata.disclosure==='internal-only')errors.push('public-safe visibility cannot be combined with internal-only.')
 if(metadata.visibility==='public-safe'&&(metadata.access_lenses||[]).includes('private'))warnings.push('public-safe visibility includes private Access Lens; review intended audience.')
 if(metadata.public_safe!==undefined&&metadata.public_safe!==null&&metadata.public_safe!==derivedPublicSafe(metadata))warnings.push(`Legacy public_safe override differs from derived value (${derivedPublicSafe(metadata)}).`)
 if(metadata.document_role==='evidence'&&!metadata.confidence)warnings.push('Evidence should declare confidence.')
 return {valid:errors.length===0,errors,warnings,derived_public_safe:derivedPublicSafe(metadata),unknown_lenses:unknown}
}
