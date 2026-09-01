"""
Importing this package registers every built-in driver (see base.py's
register_driver). main.py imports this once at startup; nothing else needs
to know the individual driver modules exist. Adding a new driver = write the
adapter file, add one import line here.
"""
from app.drivers import artnet_light_driver as artnet_light_driver
from app.drivers import modbus_motor_driver as modbus_motor_driver
from app.drivers import modbus_valve_driver as modbus_valve_driver
