// Mount point for the qol-c overlays: Forge Doctor and "Add to game" dialogs (opened through window
// events, see events.ts) and the spending-cap alert toasts.
import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { AddToGameDialog } from './AddToGame'
import { DoctorDialog } from './Doctor'
import { ADD_TO_GAME_EVENT, DOCTOR_EVENT } from './events'
import { useSpendAlerts } from './Spend'

export function QolcOverlays() {
  const { actions } = useStore()
  const [doctor, setDoctor] = useState(false)
  const [add, setAdd] = useState<{ lab: string; id: string } | null>(null)
  useSpendAlerts(actions)
  useEffect(() => {
    const onDoctor = () => setDoctor(true)
    const onAdd = (e: Event) => {
      const d = (e as CustomEvent<{ lab: string; id: string }>).detail
      if (d?.lab && d?.id) setAdd({ lab: d.lab, id: d.id })
    }
    window.addEventListener(DOCTOR_EVENT, onDoctor)
    window.addEventListener(ADD_TO_GAME_EVENT, onAdd)
    return () => {
      window.removeEventListener(DOCTOR_EVENT, onDoctor)
      window.removeEventListener(ADD_TO_GAME_EVENT, onAdd)
    }
  }, [])
  return (
    <>
      {doctor && <DoctorDialog onClose={() => setDoctor(false)} />}
      {add && <AddToGameDialog key={`${add.lab}:${add.id}`} lab={add.lab} id={add.id} onClose={() => setAdd(null)} />}
    </>
  )
}
