// Mount point for the qol-c overlays: Forge Doctor dialog (opened through window events, see
// events.ts) and the spending-cap alert toasts.
import { useEffect, useState } from 'react'
import { useActions } from '../../store'
import { DoctorDialog } from './Doctor'
import { DOCTOR_EVENT } from './events'
import { useSpendAlerts } from './Spend'

export function QolcOverlays() {
  const actions = useActions()
  const [doctor, setDoctor] = useState(false)
  useSpendAlerts(actions)
  useEffect(() => {
    const onDoctor = () => setDoctor(true)
    window.addEventListener(DOCTOR_EVENT, onDoctor)
    return () => window.removeEventListener(DOCTOR_EVENT, onDoctor)
  }, [])
  return doctor ? <DoctorDialog onClose={() => setDoctor(false)} /> : null
}
